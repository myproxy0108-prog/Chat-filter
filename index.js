const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const API_TOKEN = process.env.CHATWORK_API_TOKEN;
const WEBHOOK_TOKEN = process.env.CHATWORK_WEBHOOK_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; 
const TARGET_ROOM_ID = process.env.TARGET_ROOM_ID; 

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});

let gambleActive = false;
let localLastResetDate = null; 
const spamRecords = {};
const chState = {};

const initBot = async () => {
    try {
        const { data } = await supabase.from('config').select('value').eq('key', 'gamble_active').single();
        if (data) gambleActive = data.value === 'true';
    } catch (e) {}
};
initBot();

const getTodayStr = () => {
    const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    return jst.toISOString().split('T')[0];
};

// 月間判定用の文字列 ("2026-07" のような形)
const getThisMonthStr = () => {
    const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    return jst.toISOString().slice(0, 7);
};

const verifySignature = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    if (!sig) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return sig === expected;
};

// --- ヘルパー: 自動返済機能付き加算 ---
const addMoneyWithRepay = async (aid, amount) => {
    const { data } = await supabase.from('players').select('*').eq('account_id', aid).single();
    let money = data ? data.money : 0;
    let debt = data ? (data.debt || 0) : 0;
    
    // 借金がある場合、稼ぎを返済に優先して充てる
    if (debt > 0 && amount > 0) {
        let repay = Math.min(debt, amount);
        debt -= repay;
        amount -= repay; // 返済して残った額が所持金に加算される
    }
    money += amount;
    
    if (data) {
        await supabase.from('players').update({ money, debt }).eq('account_id', aid);
    } else {
        await supabase.from('players').insert({ account_id: aid, money, debt, slot_count: 0 });
    }
    return { money, debt };
};

const sendTempMessage = async (roomId, text, ms = 60000) => {
    try {
        const res = await cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`);
        if (res && res.data && res.data.message_id) {
            setTimeout(() => { cw.delete(`/rooms/${roomId}/messages/${res.data.message_id}`).catch(()=>{}); }, ms);
        }
    } catch(e) {}
};

const sendMessage = (roomId, text) => cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`).catch(()=>{});
const deleteMessage = (roomId, messageId) => cw.delete(`/rooms/${roomId}/messages/${messageId}`).catch(()=>{});
const makeRp = (aid, roomId, msgId) => `[rp aid=${aid} to=${roomId}-${msgId}]`;

// --- 防衛・パトロール ---
const checkSpam = (accountId) => {
    const now = Date.now();
    if (!spamRecords[accountId]) spamRecords[accountId] = [];
    spamRecords[accountId].push(now);
    spamRecords[accountId] = spamRecords[accountId].filter(t => now - t <= 5000);
    if (spamRecords[accountId].length >= 10) { spamRecords[accountId] = []; return true; }
    return false;
};

const updateRoomMembers = async (roomId, targetIds, action = 'readonly') => {
    try {
        const { data: c } = await cw.get(`/rooms/${roomId}/members`);
        let admins = c.filter(m => m.role === 'admin' || m.role === 'creator').map(m => m.account_id.toString());
        let members = c.filter(m => m.role === 'member').map(m => m.account_id.toString());
        let readonlys = c.filter(m => m.role === 'readonly').map(m => m.account_id.toString());
        let found = false;

        for (const aid of targetIds) {
            const idStr = aid.toString();
            if (admins.includes(idStr) || members.includes(idStr) || readonlys.includes(idStr)) found = true;
            admins = admins.filter(id => id !== idStr);
            members = members.filter(id => id !== idStr);
            readonlys = readonlys.filter(id => id !== idStr);
            if (action === 'readonly') readonlys.push(idStr);
        }
        if (!found) return false; 
        const params = new URLSearchParams();
        if (admins.length > 0) params.append('members_admin_ids', admins.join(','));
        if (members.length > 0) params.append('members_member_ids', members.join(','));
        if (readonlys.length > 0) params.append('members_readonly_ids', readonlys.join(','));
        await cw.put(`/rooms/${roomId}/members`, params.toString());
        return true;
    } catch (err) {}
};

const isUserAdmin = async (roomId, accountId) => {
    try {
        const { data } = await cw.get(`/rooms/${roomId}/members`);
        const member = data.find(m => m.account_id.toString() === accountId.toString());
        return member && (member.role === 'admin' || member.role === 'creator');
    } catch (e) { return false; }
};

const runPatrol = async (roomId) => {
    try {
        const { data: members } = await cw.get(`/rooms/${roomId}/members`);
        const { data: blacklist, error } = await supabase.from('blacklist').select('account_id');
        if (error || !members || !blacklist || blacklist.length === 0) return;
        const bIds = blacklist.map(b => b.account_id);
        const toPunish = members.filter(m => m.role !== 'readonly' && bIds.includes(m.account_id.toString())).map(m => m.account_id.toString());
        if (toPunish.length > 0) await updateRoomMembers(roomId, toPunish, 'readonly');
    } catch (e) {}
};

// --- 深夜0時リセット＆宝くじ ---
const checkDailyReset = async (roomId) => {
    try {
        const todayStr = getTodayStr();
        if (localLastResetDate === todayStr) return; 
        const { data } = await supabase.from('config').select('value').eq('key', 'last_reset_date').single();
        if (data && data.value === todayStr) { localLastResetDate = todayStr; return; }

        localLastResetDate = todayStr;
        await supabase.from('players').update({ slot_count: 0, work_date: null, skill_date: null }).neq('account_id', '0');
        await supabase.from('config').upsert({ key: 'last_reset_date', value: todayStr });
        
        let msg = `[info][title]🔄 日替わりリセット[/title]深夜0時です。\nスロット回数と職業スキル制限がリセットされました！\n\n`;

        const { data: lotData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
        let tickets = lotData ? JSON.parse(lotData.value) : [];
        if (tickets.length > 0) {
            let winNum = Math.floor(Math.random() * 9999) + 1;
            msg += `[title]🎯 宝くじ抽選結果[/title]当選番号:【 ${winNum} 】\n\n`;
            let payouts = {}; let winners = [];
            
            const getPrize = (num, win) => {
                if (num === win) return { p: 30000, n: '1等' };
                let prev = win - 1 < 1 ? 9999 : win - 1; let next = win + 1 > 9999 ? 1 : win + 1;
                if (num === prev || num === next) return { p: 15000, n: '前後賞' };
                if (num % 1000 === win % 1000) return { p: 10000, n: '2等' }; 
                if (num % 100 === win % 100) return { p: 5000, n: '3等' };    
                if (num % 10 === win % 10) return { p: 1000, n: '4等' };      
                return null;
            };
            
            for (let t of tickets) {
                let r = getPrize(t.num, winNum);
                if (r) { winners.push({ aid: t.aid, num: t.num, ...r }); payouts[t.aid] = (payouts[t.aid] || 0) + r.p; }
            }
            if (winners.length > 0) {
                for (let aid in payouts) await addMoneyWithRepay(aid, payouts[aid]);
                winners.sort((a, b) => b.p - a.p);
                for (let w of winners) msg += `[piconname:${w.aid}]: ${w.num} ➡ ${w.n} (+${w.p})\n`;
            } else { msg += `本日の当選者はいませんでした。\n`; }
            await supabase.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
        }
        if (roomId) await sendMessage(roomId, msg + `[/info]`);
    } catch (e) {}
};

// --- 丁半ゲーム管理 ---
const handleTimeout = async (roomId) => {
    try {
        let ch = chState[roomId]; if (!ch || ch.state === 'IDLE') return;

        if (ch.state === 'RECRUITING') {
            if (ch.players.length >= 2) {
                ch.state = 'BETTING';
                await sendTempMessage(roomId, `[info]⏳ 1分経過のため丁半ゲームを自動開始します！\n参加者は /bet 掛け金 でベットしてください。[/info]`);
                startTimer(roomId, 60000);
            } else {
                await sendTempMessage(roomId, `[info]参加者が足りないため丁半ゲームを中止します。[/info]`);
                chState[roomId] = { state: 'IDLE', players: [] };
            }
        } else {
            let kicked = []; let active = [];
            for (let p of ch.players) {
                if ((ch.state === 'BETTING' && p.bet === 0) || (ch.state === 'CHOOSING' && !p.choice)) {
                    kicked.push(p.aid);
                    if (p.bet > 0) await addMoneyWithRepay(p.aid, p.bet);
                } else active.push(p);
            }
            ch.players = active;
            if (kicked.length > 0) await sendTempMessage(roomId, `[info]⏳ 未操作のため以下を退場させました:\n${kicked.map(a=>`[piconname:${a}]`).join(' ')}[/info]`);
            
            if (ch.players.length < 2) {
                for (let p of ch.players) if (p.bet > 0) await addMoneyWithRepay(p.aid, p.bet);
                await sendTempMessage(roomId, `[info]人数不足のため中止し返金しました。[/info]`);
                chState[roomId] = { state: 'IDLE', players: [] };
            } else if (ch.state === 'BETTING') {
                ch.state = 'CHOOSING';
                await sendTempMessage(roomId, `[info]丁半選択フェーズへ移行します。 /chou か /han を選んでください。[/info]`);
                startTimer(roomId, 60000);
            } else {
                resolveChouhan(roomId);
            }
        }
    } catch (e) {}
};

const startTimer = (roomId, ms = 60000) => {
    let ch = chState[roomId];
    if (ch.timeoutId) clearTimeout(ch.timeoutId);
    ch.timeoutId = setTimeout(() => handleTimeout(roomId), ms);
};

const resolveChouhan = async (roomId) => {
    try {
        let ch = chState[roomId]; if (!ch) return;
        if (ch.timeoutId) clearTimeout(ch.timeoutId);
        let d1 = Math.floor(Math.random() * 6) + 1, d2 = Math.floor(Math.random() * 6) + 1;
        let sum = d1 + d2;
        let res = (sum % 2 === 0) ? 'chou' : 'han';
        let msg = `[info][title]🎲 結果発表[/title]出目: ${d1}, ${d2} (合計: ${sum})\n➡ 『 ${res === 'chou' ? '丁(偶数)' : '半(奇数)'} 』の勝ち！\n\n`;

        for (let p of ch.players) {
            if (p.choice === res) {
                await addMoneyWithRepay(p.aid, p.bet * 2);
                msg += `[piconname:${p.aid}]: 当たり！ (+${p.bet * 2} コイン)\n`;
            } else msg += `[piconname:${p.aid}]: はずれ\n`;
        }
        await sendMessage(roomId, msg + "[/info]");
        chState[roomId] = { state: 'IDLE', players: [] };
    } catch (e) {}
};

// --- メイン Webhook ---
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid');
    res.status(200).send('OK'); 

    const event = req.body.webhook_event;
    if (!event || req.body.webhook_event_type !== 'message_created') return;

    const roomId = event.room_id, body = event.body || "", senderId = event.account_id.toString(), msgId = event.message_id;
    const today = getTodayStr();

    (async () => {
        try {
            // ★返信タグ完全解析
            const rpMatch = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const repliedAid = rpMatch ? rpMatch[1] : null;

            // 1. ブラックリスト判定
            const { data: isBanned } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId);
            if (isBanned && isBanned.length > 0) {
                await updateRoomMembers(roomId, [senderId], 'readonly'); 
                await deleteMessage(roomId, msgId); 
                return;
            }
            
            runPatrol(roomId); checkDailyReset(roomId);

            // 2. スパム検知
            if (checkSpam(senderId) && !(await isUserAdmin(roomId, senderId))) {
                await updateRoomMembers(roomId, [senderId], 'readonly');
                return sendTempMessage(roomId, `[info]⚠️ [piconname:${senderId}] 連投につき閲覧制限しました。[/info]`);
            }

            // 3. ヘルプ
            if (body.trim() === '/help-gya') {
                const h = `[info][title]🎰 カジノ＆ライフ[/title]
[b]【 基本 】[/b]
/status : ステータス確認
/give [金額] : 返信で相手に送金 (※10%の税金が引かれます)
/debt [金額] : 借金する (1ヶ月の上限5000コインまで)
/money-rank : 純資産(所持金-借金)ランキング

[b]【 職業 】[/b]
/job : 求人一覧と転職
/work : 職業の給料 (1日1回)
/catch または /goal : 特殊能力 (1日1回)

[b]【 ゲーム 】[/b]
/slot [掛金] : スロット (1日3回)
/buy-lot [数字] : 宝くじ購入 (100コイン、0時抽選)
/chouhan : 丁半ゲーム募集

[b]【 管理者専用 】[/b]
/st-gya, /fi-gya : ギャンブルON/OFF
/blacklist, /reblacklist : 追放管理
/remove-rank : ランキング除外[/info]`;
                return await sendTempMessage(roomId, h, 120000);
            }

            // --- 管理者系 ---
            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body)) {
                if (!(await isUserAdmin(roomId, senderId))) return;
                let targetAid = repliedAid; 
                let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'remove' : 'add');
                if (!targetAid) {
                    const m = body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/);
                    if (m) targetAid = m[2];
                    else if (cmd === 'add') cmd = 'list';
                    else return;
                }

                if (cmd === 'rank') {
                    const { data: exD } = await supabase.from('config').select('value').eq('key', 'rank_excluded').single();
                    let ex = exD ? JSON.parse(exD.value) : [];
                    if (ex.includes(targetAid)) {
                        ex = ex.filter(id => id !== targetAid);
                        await sendTempMessage(roomId, `[info][piconname:${targetAid}] ランキング除外を解除しました。[/info]`);
                    } else {
                        ex.push(targetAid);
                        await sendTempMessage(roomId, `[info][piconname:${targetAid}] をランキングから除外しました。[/info]`);
                    }
                    return await supabase.from('config').upsert({ key: 'rank_excluded', value: JSON.stringify(ex) });
                }

                if (cmd === 'add') {
                    const { data: ex } = await supabase.from('blacklist').select('account_id').eq('account_id', targetAid);
                    if (ex && ex.length > 0) return await sendTempMessage(roomId, `[info]既に登録されています。[/info]`);
                    await supabase.from('blacklist').insert({ account_id: targetAid });
                    await updateRoomMembers(roomId, [targetAid], 'readonly');
                    return await sendTempMessage(roomId, `[info][piconname:${targetAid}] をBL登録し、閲覧のみに変更しました。[/info]`);
                } else if (cmd === 'remove') {
                    await supabase.from('blacklist').delete().eq('account_id', targetAid);
                    return await sendTempMessage(roomId, `[info][piconname:${targetAid}] をBLから解除しました。[/info]`);
                } else if (cmd === 'list') {
                    const { data } = await supabase.from('blacklist').select('account_id');
                    const ls = data && data.length > 0 ? data.map(d => `[piconname:${d.account_id}] (ID: ${d.account_id})`).join('\n') : "なし";
                    return await sendTempMessage(roomId, `[info][title]BL一覧[/title]${ls}\n\n※1分で消えます[/info]`);
                }
            }

            if (body.startsWith('/st-gya') && await isUserAdmin(roomId, senderId)) {
                gambleActive = true; await supabase.from('config').upsert({ key: 'gamble_active', value: 'true' });
                return sendMessage(roomId, `[info]🎰 ギャンブル機能ON[/info]`);
            }
            if (body.startsWith('/fi-gya') && await isUserAdmin(roomId, senderId)) {
                gambleActive = false; await supabase.from('config').upsert({ key: 'gamble_active', value: 'false' });
                return sendMessage(roomId, `[info]🚫 ギャンブル機能OFF[/info]`);
            }

            // プレイヤーデータ取得
            const { data: pData } = await supabase.from('players').select('*').eq('account_id', senderId).single();
            let myMoney = pData ? pData.money : 0;
            let myDebt = pData ? (pData.debt || 0) : 0;
            let myJob = pData ? (pData.job || 'サラリーマン') : 'サラリーマン';
            
            // 月間借金額の取得
            const thisMonth = getThisMonthStr();
            let currentMonthlyDebt = (pData && pData.debt_month === thisMonth) ? (pData.monthly_debt || 0) : 0;

            // --- 借金・送金 ---
            const debtMatch = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (debtMatch && gambleActive) {
                let amt = parseInt(debtMatch[2], 10);
                if (amt > 0) {
                    if (currentMonthlyDebt + amt > 5000) {
                        return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} 1ヶ月の借金上限は5000コインです！\n(今月すでに ${currentMonthlyDebt} コイン借りています)`);
                    }
                    if (pData) {
                        await supabase.from('players').update({ money: myMoney + amt, debt: myDebt + amt, monthly_debt: currentMonthlyDebt + amt, debt_month: thisMonth }).eq('account_id', senderId);
                    } else {
                        await supabase.from('players').insert({ account_id: senderId, money: amt, debt: amt, slot_count: 0, monthly_debt: amt, debt_month: thisMonth });
                    }
                    return await sendTempMessage(roomId, `[info]💸 [piconname:${senderId}] ${amt}コインを借金しました！\n(今月の借金可能枠: ${5000 - (currentMonthlyDebt + amt)})\n※借金を含んだお金は他人に送金できません。[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && gambleActive) {
                let targetAid = repliedAid; let amount = 0;
                if (targetAid) {
                    const match = body.match(/(^|\n)\/give\s+([0-9]+)/);
                    if (match) amount = parseInt(match[2], 10);
                } else {
                    const match = body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/);
                    if (match) { targetAid = match[2]; amount = parseInt(match[3], 10); }
                }

                if (!targetAid || isNaN(amount) || amount <= 0) return;
                
                let avMoney = Math.max(0, myMoney - myDebt);
                if (avMoney < amount) return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} 送金枠不足！\n(借金があるため、送金できる純資産は ${avMoney} コインです)`);
                
                // ★税金(10%)処理
                let tax = Math.floor(amount * 0.10);
                let receiveAmt = amount - tax;

                await supabase.from('players').update({ money: myMoney - amount }).eq('account_id', senderId);
                const { data: rec } = await supabase.from('players').select('*').eq('account_id', targetAid).single();
                if (rec) await supabase.from('players').update({ money: rec.money + receiveAmt }).eq('account_id', targetAid);
                else await supabase.from('players').insert({ account_id: targetAid, money: receiveAmt, debt: 0, slot_count: 0 });
                
                return await sendTempMessage(roomId, `[info]🎁 [piconname:${senderId}] ➡ [piconname:${targetAid}]\n${amount} コインを送金しました。\n(※税金10%として ${tax} コインが引かれ、相手には ${receiveAmt} コインが届きました)[/info]`);
            }

            // --- ステータス・ランキング ---
            if (body.trim() === '/status') {
                if (pData) {
                    const remSlot = Math.max(0, 3 - pData.slot_count);
                    const dStr = myDebt > 0 ? `\n💳 借金: -${myDebt}` : '';
                    return sendTempMessage(roomId, `[info][title]📊 状態[/title][piconname:${senderId}]\n💰 所持金: ${myMoney}${dStr}\n👔 職業: ${myJob}\n🎰 スロット残: ${remSlot}回[/info]`);
                } else return sendTempMessage(roomId, `[info]まだデータがありません[/info]`);
            }

            if (body.trim() === '/money-rank') {
                const { data: exD } = await supabase.from('config').select('value').eq('key', 'rank_excluded').single();
                let ex = exD ? JSON.parse(exD.value) : [];
                const { data: list } = await supabase.from('players').select('*');
                let filtered = list ? list.filter(d => !ex.includes(d.account_id)) : [];
                
                // ★純資産 (money - debt) でランキング
                filtered.sort((a, b) => ((b.money || 0) - (b.debt || 0)) - ((a.money || 0) - (a.debt || 0)));
                
                const s = filtered.slice(0, 10).map((d, i) => {
                    let net = (d.money || 0) - (d.debt || 0);
                    let dStr = (d.debt && d.debt > 0) ? ` (所持:${d.money} 借金:-${d.debt})` : '';
                    let jStr = d.job ? ` [${d.job}]` : ` [サラリーマン]`;
                    return `${i+1}位: [piconname:${d.account_id}] - 純資産: ${net} ${dStr}${jStr}`;
                }).join('\n');
                return await sendTempMessage(roomId, `[info][title]💰 純資産ランキング TOP10[/title]${s || 'なし'}\n\n※5分後に消滅[/info]`, 300000);
            }

            // --- 職業 ---
            if (/(^|\n)\/job(\s|$)/.test(body) && gambleActive) {
                const j = `[info][title]💼 求人[/title]サラリーマン(0) ➡ /work\n公務員(2000) ➡ /work\n警察官(3000) ➡ /work, /catch\nプロスポーツ選手(5000) ➡ /work, /goal\n※転職: /job 役職名[/info]`;
                return await sendTempMessage(roomId, j, 60000);
            }

            const cJobMatch = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (cJobMatch && gambleActive) {
                const jn = cJobMatch[2]; const costs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000};
                if (myJob === jn) return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} すでに${jn}です！`);
                if (myMoney < costs[jn]) return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} お金が足りません！`);
                
                if (pData) await supabase.from('players').update({ job: jn, money: myMoney - costs[jn] }).eq('account_id', senderId);
                else await supabase.from('players').insert({ account_id: senderId, job: jn, money: -costs[jn] });
                return await sendTempMessage(roomId, `[info]💼 [piconname:${senderId}] ${jn} に転職しました！[/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive) {
                if (!pData) return;
                if (pData.work_date === today) return sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} 今日の仕事は終わっています。`);
                
                let earn = 0; let msg = "";
                if (myJob === 'サラリーマン') {
                    if (Math.random() < 0.1) { earn = 0; msg = "ミスで給料0コインに..."; } 
                    else { earn = Math.floor(Math.random()*401)+100; msg = `${earn} コイン稼ぎました！`; }
                } else if (myJob === '公務員') { earn = Math.floor(Math.random()*201)+300; msg = `${earn} コイン稼ぎました！`; }
                else if (myJob === '警察官') { earn = Math.floor(Math.random()*401)+300; msg = `${earn} コイン稼ぎました！`; }
                else if (myJob === 'プロスポーツ選手') { earn = Math.floor(Math.random()*501)+500; msg = `${earn} コイン稼ぎました！`; }
                
                await supabase.from('players').update({ work_date: today }).eq('account_id', senderId);
                await addMoneyWithRepay(senderId, earn);
                return await sendTempMessage(roomId, `[info]💼 [piconname:${senderId}]\n${msg}[/info]`);
            }

            if ((/(^|\n)\/catch\b/.test(body) || /(^|\n)\/goal\b/.test(body)) && gambleActive) {
                if (!pData) return;
                let isCatch = /(^|\n)\/catch\b/.test(body);
                if (isCatch && myJob !== '警察官') return sendTempMessage(roomId, `警察官専用です！`);
                if (!isCatch && myJob !== 'プロスポーツ選手') return sendTempMessage(roomId, `プロ専用です！`);
                if (pData.skill_date === today) return sendTempMessage(roomId, `今日の能力は使用済みです`);

                let succ = Math.random() < 0.3; let earn = 0; let msg = "";
                if (isCatch) {
                    if (succ) { earn = 800; msg = `犯人逮捕！報酬 ${earn} 獲得！`; } else msg = `犯人を逃しました...`;
                } else {
                    if (succ) { earn = 1000; msg = `スーパーゴール！ ${earn} 獲得！`; } else msg = `シュート外れました...`;
                }
                await supabase.from('players').update({ skill_date: today }).eq('account_id', senderId);
                await addMoneyWithRepay(senderId, earn);
                return await sendTempMessage(roomId, `[info][piconname:${senderId}]\n${msg}[/info]`);
            }

            // --- 宝くじ ---
            const lotMatch = body.match(/(^|\n)\/buy-lot\s+([0-9]+)/);
            if (lotMatch && gambleActive && myMoney >= 100) {
                let num = parseInt(lotMatch[2], 10);
                if (num >= 1 && num <= 9999) {
                    const { data: lData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = lData ? JSON.parse(lData.value) : [];
                    if (tks.some(t => t.num === num)) return sendTempMessage(roomId, `番号【 ${num} 】は購入済みです！`);
                    if (myMoney < 100) return sendTempMessage(roomId, `お金が足りません！`);
                    
                    await supabase.from('players').update({ money: myMoney - 100 }).eq('account_id', senderId);
                    tks.push({ aid: senderId, num: num });
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tks) });
                    return await sendTempMessage(roomId, `[info]🎟 [piconname:${senderId}] 宝くじ【 ${num} 】購入完了[/info]`);
                }
            }

            // --- スロット ---
            const slotMatch = body.match(/(^|\n)\/slot\s+([0-9]+)/);
            if (slotMatch && gambleActive) {
                const betAmt = parseInt(slotMatch[2], 10);
                if (betAmt > 0) {
                    if (myMoney < betAmt) return sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} お金が足りません！`);
                    if (pData && pData.slot_count >= 3) return sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} スロットは1日3回までです`);
                    
                    await supabase.from('players').update({ money: myMoney - betAmt }).eq('account_id', senderId);
                    
                    const rand = Math.floor(Math.random() * 100);
                    let mlt = 0, sym = "", res = "";
                    if (rand === 0) { mlt = 100; sym = "🐉 | 🐉 | 🐉"; res = "超大当たり！"; } 
                    else if (rand <= 3) { mlt = 10; sym = "7️⃣ | 7️⃣ | 7️⃣"; res = "大当たり！"; } 
                    else if (rand <= 9) { mlt = 3; let s = ["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sym = `${s} | ${s} | ${s}`; res = "当たり！"; } 
                    else if (rand <= 19) { mlt = 2; let s = ["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sym = `${s} | ${s} | ${s}`; res = "当たり！"; } 
                    else if (rand <= 29) { mlt = 2; let s = ["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sym = `${s} | ${s} | ${s}`; res = "フルーツ揃い！"; } 
                    else if (rand <= 49) { mlt = 2; let oth = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1 = oth[Math.floor(Math.random()*oth.length)], s2 = oth[Math.floor(Math.random()*oth.length)]; let a = ["🍒", s1, s2].sort(()=>Math.random()-0.5); sym = a.join(" | "); res = "チェリー出現！"; } 
                    else { mlt = 0; let oth = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=oth[Math.floor(Math.random()*oth.length)], r2=oth[Math.floor(Math.random()*oth.length)], r3=oth[Math.floor(Math.random()*oth.length)]; while(r1===r2 && r2===r3) r3=oth[Math.floor(Math.random()*oth.length)]; sym = `${r1} | ${r2} | ${r3}`; res = "はずれ！"; }
                    
                    let wAmt = betAmt * mlt;
                    await supabase.from('players').update({ slot_count: (pData?pData.slot_count:0)+1 }).eq('account_id', senderId);
                    if (wAmt > 0) await addMoneyWithRepay(senderId, wAmt);
                    
                    return await sendMessage(roomId, `${makeRp(senderId, roomId, msgId)}\n🎰 スロット\n【 ${sym} 】\n${res} (${wAmt}獲得)`);
                }
            }

            // --- 丁半 ---
            if (!chState[roomId]) chState[roomId] = { state: 'IDLE', players: [] };
            let ch = chState[roomId];
            if (body.trim() === '/chouhan' && gambleActive && ch.state === 'IDLE') {
                ch.state = 'RECRUITING'; ch.players = [{ aid: senderId, bet: 0, choice: null }];
                sendMessage(roomId, "🎲 丁半募集！ /join chouhan で参加"); startTimer(roomId);
            } else if (body.trim() === '/join chouhan' && ch.state === 'RECRUITING' && !ch.players.find(x=>x.aid===senderId)) {
                ch.players.push({ aid: senderId, bet: 0, choice: null });
                sendMessage(roomId, `[piconname:${senderId}] 参加！ (${ch.players.length}人)`);
            } else if (body.match(/(^|\n)\/bet\s+([0-9]+)/) && ch.state === 'BETTING') {
                let b = parseInt(body.match(/(^|\n)\/bet\s+([0-9]+)/)[2], 10);
                let plr = ch.players.find(x=>x.aid===senderId);
                if (plr && b > 0 && myMoney >= b) {
                    plr.bet = b; await supabase.from('players').update({ money: myMoney - b }).eq('account_id', senderId);
                    if (ch.players.length >= 2 && ch.players.every(x=>x.bet>0)) { ch.state = 'CHOOSING'; sendMessage(roomId, "丁半選べ！ /chou /han"); startTimer(roomId); }
                }
            } else if ((body.trim() === '/chou' || body.trim() === '/han') && ch.state === 'CHOOSING') {
                let plr = ch.players.find(x=>x.aid===senderId);
                if (plr && !plr.choice) {
                    plr.choice = body.trim().slice(1);
                    if (ch.players.length >= 2 && ch.players.every(x=>x.choice)) resolveChouhan(roomId);
                }
            } else if (body.trim() === '/leave' && ch.state !== 'IDLE') {
                let lP = ch.players.find(x=>x.aid === senderId);
                ch.players = ch.players.filter(x=>x.aid !== senderId);
                if (lP && lP.bet > 0) await addMoneyWithRepay(senderId, lP.bet);
                sendMessage(roomId, `[piconname:${senderId}] 退出`);
                if (ch.players.length === 0) ch.state = 'IDLE';
            }

            // --- コイン付与 ---
            if (gambleActive && !body.trim().startsWith('/')) {
                await addMoneyWithRepay(senderId, 1);
            }

        } catch (e) { console.error(e); }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;
