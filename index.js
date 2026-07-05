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
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().split('T')[0];
};

const verifySignature = (req) => {
    const signature = req.headers['x-chatworkwebhooksignature'];
    if (!signature) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return signature === expected;
};

// --- メッセージ機能（自動削除 ＆ 返信タグ） ---
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
        const { data: currentMembers } = await cw.get(`/rooms/${roomId}/members`);
        let admins = currentMembers.filter(m => m.role === 'admin' || m.role === 'creator').map(m => m.account_id.toString());
        let members = currentMembers.filter(m => m.role === 'member').map(m => m.account_id.toString());
        let readonlys = currentMembers.filter(m => m.role === 'readonly').map(m => m.account_id.toString());
        let targetFound = false;

        for (const aid of targetIds) {
            const idStr = aid.toString();
            if (admins.includes(idStr) || members.includes(idStr) || readonlys.includes(idStr)) targetFound = true;
            admins = admins.filter(id => id !== idStr);
            members = members.filter(id => id !== idStr);
            readonlys = readonlys.filter(id => id !== idStr);
            
            if (action === 'readonly') readonlys.push(idStr);
        }
        if (!targetFound) return false; 
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
        const blacklistedIds = blacklist.map(b => b.account_id);
        
        // ブラックリスト対象者で、まだreadonlyになっていない人を検知
        const toPunish = members.filter(m => m.role !== 'readonly' && blacklistedIds.includes(m.account_id.toString())).map(m => m.account_id.toString());
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
        
        let resetMsg = `[info][title]🔄 日替わりリセット[/title]深夜0時になりました。\n全プレイヤーのスロット回数・職業スキル制限がリセットされました！\n\n`;

        try {
            const { data: lotData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
            let tickets = lotData ? JSON.parse(lotData.value) : [];
            if (tickets.length > 0) {
                let winNum = Math.floor(Math.random() * 9999) + 1;
                resetMsg += `[title]🎯 本日の宝くじ抽選結果[/title]当選番号は【 ${winNum} 】です！\n\n`;
                let payouts = {}; let winners = [];
                
                const checkPrize = (num, win) => {
                    if (num === win) return { prize: 30000, name: '1等' };
                    let prev = win - 1 < 1 ? 9999 : win - 1; let next = win + 1 > 9999 ? 1 : win + 1;
                    if (num === prev || num === next) return { prize: 15000, name: '前後賞' };
                    if (num % 100 === win % 100) return { prize: 10000, name: '2等' }; 
                    if (num % 1000 === win % 1000) return { prize: 5000, name: '3等' };    
                    if (num % 10 === win % 10) return { prize: 1000, name: '4等' };      
                    return null;
                };
                
                for (let t of tickets) {
                    let res = checkPrize(t.num, winNum);
                    if (res) { winners.push({ aid: t.aid, num: t.num, ...res }); payouts[t.aid] = (payouts[t.aid] || 0) + res.prize; }
                }
                
                if (winners.length > 0) {
                    for (let aid in payouts) {
                        const { data: p } = await supabase.from('players').select('money').eq('account_id', aid).single();
                        if (p) await supabase.from('players').update({ money: p.money + payouts[aid] }).eq('account_id', aid);
                    }
                    winners.sort((a, b) => b.prize - a.prize);
                    for (let w of winners) resetMsg += `[piconname:${w.aid}]: ${w.num} ➡ ${w.name} (+${w.prize}コイン)\n`;
                } else { resetMsg += `本日の当選者は残念ながらいませんでした。\n`; }
                await supabase.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
            }
        } catch(e) {}

        resetMsg += `[/info]`;
        if (roomId) await sendMessage(roomId, resetMsg);
    } catch (e) {}
};

// --- 丁半ゲーム管理 ---
const handleTimeout = async (roomId) => {
    try {
        let ch = chState[roomId]; if (!ch || ch.state === 'IDLE') return;

        if (ch.state === 'RECRUITING') {
            if (ch.players.length >= 2) {
                ch.state = 'BETTING';
                await sendTempMessage(roomId, `[info]⏳ 1分経過しました。\n丁半ゲームを開始します！参加者は /bet 掛け金 でベットしてください。(制限1分)[/info]`);
                startTimer(roomId, 60000);
            } else {
                await sendTempMessage(roomId, `[info]参加者が2人未満のため、丁半ゲームを中止します。[/info]`);
                chState[roomId] = { state: 'IDLE', players: [] };
            }
        } else if (ch.state === 'BETTING' || ch.state === 'CHOOSING') {
            let kicked = []; let active = [];
            for (let p of ch.players) {
                if ((ch.state === 'BETTING' && p.bet === 0) || (ch.state === 'CHOOSING' && !p.choice)) {
                    kicked.push(p.aid);
                    if (p.bet > 0) {
                        const { data } = await supabase.from('players').select('money').eq('account_id', p.aid).single();
                        if (data) await supabase.from('players').update({ money: data.money + p.bet }).eq('account_id', p.aid);
                    }
                } else active.push(p);
            }
            ch.players = active;
            if (kicked.length > 0) await sendTempMessage(roomId, `[info]⏳ 制限時間超過のため以下を退出・返金しました。\n${kicked.map(aid=>`[piconname:${aid}]`).join(' ')}[/info]`);
            
            if (ch.players.length < 2) {
                for (let p of ch.players) {
                    try {
                        const { data } = await supabase.from('players').select('money').eq('account_id', p.aid).single();
                        if (data) await supabase.from('players').update({ money: data.money + p.bet }).eq('account_id', p.aid);
                    } catch(e){}
                }
                await sendTempMessage(roomId, `[info]参加者が2人未満になったため中止し、全額返金しました。[/info]`);
                chState[roomId] = { state: 'IDLE', players: [] };
            } else if (ch.state === 'BETTING') {
                ch.state = 'CHOOSING';
                await sendTempMessage(roomId, `[info][title]🎲 丁半 選択[/title]全員のベットが完了しました！\n/chou または /han を予想してください。(制限1分)[/info]`);
                startTimer(roomId, 60000);
            } else {
                await resolveChouhan(roomId);
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
        
        let d1 = Math.floor(Math.random() * 6) + 1;
        let d2 = Math.floor(Math.random() * 6) + 1;
        let sum = d1 + d2;
        let resultType = (sum % 2 === 0) ? 'chou' : 'han';
        
        let msg = `[info][title]🎲 結果発表[/title]サイコロの目は【 ${d1} 】と【 ${d2} 】\n合計： ${sum} ➡ 『 ${resultType === 'chou' ? '丁(偶数)' : '半(奇数)'} 』！\n\n`;

        for (let p of ch.players) {
            if (p.choice === resultType) {
                const { data } = await supabase.from('players').select('money').eq('account_id', p.aid).single();
                if (data) await supabase.from('players').update({ money: data.money + p.bet * 2 }).eq('account_id', p.aid);
                msg += `[piconname:${p.aid}]: 当たり！ (+${p.bet * 2} コイン)\n`;
            } else {
                msg += `[piconname:${p.aid}]: はずれ\n`;
            }
        }
        await sendMessage(roomId, msg + "[/info]");
        chState[roomId] = { state: 'IDLE', players: [] };
    } catch (e) {}
};

// --- Webhook メイン処理 ---
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid');
    res.status(200).send('OK'); 

    const event = req.body.webhook_event;
    if (!event || req.body.webhook_event_type !== 'message_created') return;

    const roomId = event.room_id, body = event.body || "", senderId = event.account_id.toString(), msgId = event.message_id;
    const today = getTodayStr();

    (async () => {
        try {
            // ★返信タグ解析 (rp, 返信, qtmeta, reply 全対応)
            const rpMatch = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const repliedAid = rpMatch ? rpMatch[1] : null;

            // 1. ブラックリスト判定 (発言した瞬間に発言を削除し「閲覧のみ」にする)
            const { data: isBanned } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId);
            if (isBanned && isBanned.length > 0) {
                await updateRoomMembers(roomId, [senderId], 'readonly'); 
                await deleteMessage(roomId, msgId); 
                return;
            }
            
            runPatrol(roomId);
            checkDailyReset(roomId);

            // 2. スパム検知 (5秒間に10回発言で閲覧のみに落とす。管理者は無効)
            if (checkSpam(senderId)) {
                if (!(await isUserAdmin(roomId, senderId))) {
                    await updateRoomMembers(roomId, [senderId], 'readonly');
                    await sendTempMessage(roomId, `[info]⚠️ [piconname:${senderId}] 連投を検知したため、権限を「閲覧のみ」に制限しました。[/info]`);
                    return;
                }
            }

            // 3. ヘルプ・コマンド
            if (body.trim() === '/help-gya') {
                const helpMsg = `[info][title]🎰 カジノ＆ライフ コマンド一覧[/title]
[b]【 基本 】[/b]
/status : 自分の所持金・借金・職業などを確認
/give [金額] : 返信で相手を指定してコインを送金 (※純資産分のみ)
/debt [金額] : 借金する
/money-rank : 所持金ランキング (5分で消滅)

[b]【 職業 】[/b]
/job : 職業一覧と給与を確認
/job [職業名] : 転職する
/work : 職業に応じた給料をもらう (1日1回)
/catch または /goal : 特定職業の特殊能力 (1日1回)

[b]【 ゲーム 】[/b]
/slot [掛金] : スロット (1日3回)
/buy-lot [1〜9999の数字] : 宝くじ購入 (1枚100コイン、0時抽選)
/chouhan : 丁半ゲームの募集を開始

[b]【 管理者専用 】[/b]
/st-gya : ギャンブル有効化
/fi-gya : ギャンブル無効化
/blacklist : ブラックリスト追加 (返信対応、追加された人は閲覧のみ化)
/remove-rank : ランキングから指定の人を除外
[/info]`;
                return await sendTempMessage(roomId, helpMsg, 120000);
            }

            // --- 管理者系 (ブラックリスト / ランキング除外) ---
            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body)) {
                if (!(await isUserAdmin(roomId, senderId))) return;
                
                let targetAid = repliedAid; 
                let commandType = '';
                
                if (body.includes('/remove-rank')) commandType = 'rank';
                else if (body.includes('/reblacklist')) commandType = 'remove';
                else commandType = 'add';

                if (!targetAid) {
                    const cmdMatch = body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/);
                    if (cmdMatch) targetAid = cmdMatch[2];
                    else if (commandType === 'add') commandType = 'list';
                    else return;
                }

                if (commandType === 'rank') {
                    const { data: excData } = await supabase.from('config').select('value').eq('key', 'rank_excluded').single();
                    let excluded = excData ? JSON.parse(excData.value) : [];
                    if (excluded.includes(targetAid)) {
                        excluded = excluded.filter(id => id !== targetAid);
                        await sendTempMessage(roomId, `[info][piconname:${targetAid}] をランキング除外から【解除】しました。[/info]`);
                    } else {
                        excluded.push(targetAid);
                        await sendTempMessage(roomId, `[info][piconname:${targetAid}] をランキングから【除外】しました。[/info]`);
                    }
                    return await supabase.from('config').upsert({ key: 'rank_excluded', value: JSON.stringify(excluded) });
                }

                if (commandType === 'add') {
                    const { data: existing } = await supabase.from('blacklist').select('account_id').eq('account_id', targetAid);
                    if (existing && existing.length > 0) {
                        return await sendTempMessage(roomId, `[info][piconname:${targetAid}] は【既に】ブラックリストに登録されています。[/info]`);
                    } else {
                        await supabase.from('blacklist').insert({ account_id: targetAid });
                        await updateRoomMembers(roomId, [targetAid], 'readonly'); // ★キックではなく閲覧のみにする
                        return await sendTempMessage(roomId, `[info][piconname:${targetAid}] をブラックリストに登録し、閲覧のみに変更しました。[/info]`);
                    }
                } else if (commandType === 'remove') {
                    await supabase.from('blacklist').delete().eq('account_id', targetAid);
                    return await sendTempMessage(roomId, `[info][piconname:${targetAid}] をブラックリストから解除しました。[/info]`);
                } else if (commandType === 'list') {
                    const { data } = await supabase.from('blacklist').select('account_id');
                    const listStr = data && data.length > 0 ? data.map(d => `[piconname:${d.account_id}] (ID: ${d.account_id})`).join('\n') : "登録なし";
                    return await sendTempMessage(roomId, `[info][title]ブラックリスト一覧[/title]${listStr}\n\n※1分後に自動消去されます[/info]`);
                }
            }

            // --- ギャンブル有効/無効 ---
            if (body.startsWith('/st-gya')) {
                if (!(await isUserAdmin(roomId, senderId))) return;
                gambleActive = true; await supabase.from('config').upsert({ key: 'gamble_active', value: 'true' });
                return await sendMessage(roomId, `[info][title]🎰 ギャンブル開始[/title]機能が有効になりました！発言ごとに1コイン獲得できます。[/info]`);
            }
            if (body.startsWith('/fi-gya')) {
                if (!(await isUserAdmin(roomId, senderId))) return;
                gambleActive = false; await supabase.from('config').upsert({ key: 'gamble_active', value: 'false' });
                return await sendMessage(roomId, `[info]🚫 ギャンブル機能が無効になりました。[/info]`);
            }

            // プレイヤーデータ取得
            const { data: pData } = await supabase.from('players').select('*').eq('account_id', senderId).single();
            let myMoney = pData ? pData.money : 0;
            let myDebt = pData ? (pData.debt || 0) : 0;
            let myJob = pData ? (pData.job || 'サラリーマン') : 'サラリーマン';

            // --- ★借金・送金機能 ---
            const debtMatch = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (debtMatch && gambleActive) {
                let amt = parseInt(debtMatch[2], 10);
                if (amt > 0) {
                    if (pData) await supabase.from('players').update({ money: myMoney + amt, debt: myDebt + amt }).eq('account_id', senderId);
                    else await supabase.from('players').insert({ account_id: senderId, money: amt, debt: amt, slot_count: 0 });
                    return await sendTempMessage(roomId, `[info]💸 [piconname:${senderId}] ${amt}コインを借金しました！\n(※借金を含んだお金は他人に送金できません)[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && gambleActive) {
                let targetAid = repliedAid; 
                let amount = 0;
                if (targetAid) {
                    const match = body.match(/(^|\n)\/give\s+([0-9]+)/);
                    if (match) amount = parseInt(match[2], 10);
                } else {
                    const match = body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/);
                    if (match) { targetAid = match[2]; amount = parseInt(match[3], 10); }
                }

                if (!targetAid || isNaN(amount) || amount <= 0) return;
                
                // ★借金制限：純資産（所持金 - 借金）までしか送れない
                let availableMoney = Math.max(0, myMoney - myDebt);
                if (availableMoney < amount) {
                    return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} 送金枠が足りません！\n(借金があるため、送金できる純資産は ${availableMoney} コインです)`);
                }
                
                const { data: receiver } = await supabase.from('players').select('*').eq('account_id', targetAid).single();
                await supabase.from('players').update({ money: myMoney - amount }).eq('account_id', senderId);
                if (receiver) await supabase.from('players').update({ money: receiver.money + amount }).eq('account_id', targetAid);
                else await supabase.from('players').insert({ account_id: targetAid, money: amount, debt: 0, slot_count: 0 });
                
                return await sendTempMessage(roomId, `[info]🎁 [piconname:${senderId}] ➡ [piconname:${targetAid}]\n${amount} コインを送金しました。[/info]`);
            }

            // --- ステータス・ランキング ---
            if (body.trim() === '/status') {
                if (pData) {
                    const remainSlot = Math.max(0, 3 - pData.slot_count);
                    const debtStr = myDebt > 0 ? `\n💳 借金: -${myDebt} コイン` : '';
                    return await sendTempMessage(roomId, `[info][title]📊 ステータス[/title][piconname:${senderId}] さんの情報\n💰 所持金: ${myMoney} コイン${debtStr}\n👔 職業: ${myJob}\n🎰 本日のスロット残り: ${remainSlot} 回\n\n※1分後に自動消去されます[/info]`);
                } else {
                    return await sendTempMessage(roomId, `[info][title]📊 ステータス[/title][piconname:${senderId}] さんのデータはまだありません。\n\n※1分後に自動消去されます[/info]`);
                }
            }

            if (body.trim() === '/money-rank') {
                const { data: excData } = await supabase.from('config').select('value').eq('key', 'rank_excluded').single();
                let excluded = excData ? JSON.parse(excData.value) : [];
                const { data } = await supabase.from('players').select('*').order('money', { ascending: false });
                const filtered = data ? data.filter(d => !excluded.includes(d.account_id)).slice(0, 10) : [];
                
                const listStr = filtered.length > 0 
                    ? filtered.map((d, i) => {
                        let dStr = (d.debt && d.debt > 0) ? ` (借金: -${d.debt})` : '';
                        let jStr = d.job ? ` [${d.job}]` : ` [サラリーマン]`;
                        return `${i+1}位: [piconname:${d.account_id}] - ${d.money} コイン${dStr}${jStr}`;
                    }).join('\n') : "データなし";
                // ★ランキングは5分で消える
                return await sendTempMessage(roomId, `[info][title]💰 所持金ランキング TOP10[/title]${listStr}\n\n※このメッセージは5分後に自動消去されます[/info]`, 300000);
            }

            // --- 職業機能 ---
            if (/(^|\n)\/job(\s|$)/.test(body) && gambleActive) {
                const jobMsg = `[info][title]💼 ハローワーク[/title]
👨‍💼 サラリーマン (就職: 0) -> /work (100〜500) ※10%でミス0
🏛️ 公務員 (就職: 2000) -> /work (300〜500)
🚓 警察官 (就職: 3000) -> /work (300〜700) /catch (30%で800)
⚽ プロ選手 (就職: 5000) -> /work (500〜1000) /goal (30%で1000)
※転職は /job 役職名[/info]`;
                return await sendTempMessage(roomId, jobMsg, 60000);
            }

            const changeJobMatch = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (changeJobMatch && gambleActive) {
                const jn = changeJobMatch[2];
                const costs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000};
                if (myJob === jn) return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} すでに${jn}です！`);
                if (myMoney < costs[jn]) return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} お金が足りません！(費用: ${costs[jn]})`);
                
                if (pData) await supabase.from('players').update({ job: jn, money: myMoney - costs[jn] }).eq('account_id', senderId);
                else await supabase.from('players').insert({ account_id: senderId, job: jn, money: -costs[jn] });
                return await sendTempMessage(roomId, `[info]💼 [piconname:${senderId}] ${jn} に転職しました！🎉 (-${costs[jn]} コイン)[/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive) {
                if (!pData) return;
                if (pData.work_date === today) return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} 今日の仕事は終わっています。また明日！`);
                
                let earn = 0; let msg = "";
                if (myJob === 'サラリーマン') {
                    if (Math.random() < 0.1) { earn = 0; msg = "ケアレスミスをしてしまい、今日の給料は0コインに...😭"; } 
                    else { earn = Math.floor(Math.random()*401)+100; msg = `真面目に働き、 ${earn} コイン稼ぎました！💼`; }
                } else if (myJob === '公務員') { earn = Math.floor(Math.random()*201)+300; msg = `安定した仕事をこなし、 ${earn} コイン稼ぎました！🏛️`; }
                else if (myJob === '警察官') { earn = Math.floor(Math.random()*401)+300; msg = `街の平和を守り、 ${earn} コイン稼ぎました！🚓`; }
                else if (myJob === 'プロスポーツ選手') { earn = Math.floor(Math.random()*501)+500; msg = `試合で活躍し、 ${earn} コイン稼ぎました！⚽`; }
                
                await supabase.from('players').update({ money: myMoney + earn, work_date: today }).eq('account_id', senderId);
                return await sendTempMessage(roomId, `[info]💼 [piconname:${senderId}]\n${msg}[/info]`);
            }

            if ((/(^|\n)\/catch\b/.test(body) || /(^|\n)\/goal\b/.test(body)) && gambleActive) {
                if (!pData) return;
                let isCatch = /(^|\n)\/catch\b/.test(body);
                if (isCatch && myJob !== '警察官') return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} 警察官専用です！`);
                if (!isCatch && myJob !== 'プロスポーツ選手') return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} プロスポーツ選手専用です！`);
                if (pData.skill_date === today) return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} 今日の特殊能力はすでに使っています！`);

                let succ = Math.random() < 0.3; let earn = 0; let msg = "";
                if (isCatch) {
                    if (succ) { earn = 800; msg = `見事犯人を捕まえ、特別報酬 ${earn} コイン獲得！🚨`; } else msg = `犯人を逃しました...🏃‍♂️`;
                } else {
                    if (succ) { earn = 1000; msg = `スーパーゴール！スポンサーから ${earn} コイン獲得！🥅`; } else msg = `シュートは外れました...🤦‍♂️`;
                }
                await supabase.from('players').update({ money: myMoney + earn, skill_date: today }).eq('account_id', senderId);
                return await sendTempMessage(roomId, `[info][piconname:${senderId}]\n${msg}[/info]`);
            }

            // --- 宝くじ ---
            const lotMatch = body.match(/(^|\n)\/buy-lot\s+([0-9]+)/);
            if (lotMatch && gambleActive) {
                const num = parseInt(lotMatch[2], 10);
                if (num >= 1 && num <= 9999) {
                    const { data: lotData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tickets = lotData ? JSON.parse(lotData.value) : [];

                    if (tickets.some(t => t.num === num)) return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} 宝くじ番号【 ${num} 】は既に買われています！`);
                    if (myMoney < 100) return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} お金が足りません！宝くじは1枚100コインです。`);
                    
                    await supabase.from('players').update({ money: myMoney - 100 }).eq('account_id', senderId);
                    tickets.push({ aid: senderId, num: num });
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tickets) });
                    return await sendTempMessage(roomId, `[info]🎟 [piconname:${senderId}] 宝くじ【 ${num} 】を購入しました！\n(抽選は深夜0時)[/info]`);
                }
            }

            // --- スロット ---
            const slotMatch = body.match(/(^|\n)\/slot\s+([0-9]+)/);
            if (slotMatch && gambleActive) {
                const betAmount = parseInt(slotMatch[2], 10);
                if (betAmount > 0) {
                    if (myMoney < betAmount) return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} お金が足りません！ (所持: ${myMoney}コイン)`);
                    if (pData && pData.slot_count >= 3) return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} 制限到達！スロットは1日一人3回までです。（深夜0時リセット）`);
                    
                    let newMoney = myMoney - betAmount;
                    let newCount = pData ? pData.slot_count + 1 : 1;
                    const rand = Math.floor(Math.random() * 100);
                    let multiplier = 0, symbolResult = "", msgResult = "";
                    
                    if (rand === 0) { multiplier = 100; symbolResult = "🐉 | 🐉 | 🐉"; msgResult = "超大当たり！！！ (100倍)"; } 
                    else if (rand <= 3) { multiplier = 10; symbolResult = "7️⃣ | 7️⃣ | 7️⃣"; msgResult = "大当たり！ (10倍)"; } 
                    else if (rand <= 9) { multiplier = 3; const sym = ["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; symbolResult = `${sym} | ${sym} | ${sym}`; msgResult = "当たり！ (3倍)"; } 
                    else if (rand <= 19) { multiplier = 2; const sym = ["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; symbolResult = `${sym} | ${sym} | ${sym}`; msgResult = "当たり！ (2倍)"; } 
                    else if (rand <= 29) { multiplier = 2; const sym = ["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; symbolResult = `${sym} | ${sym} | ${sym}`; msgResult = "フルーツ揃い！当たり！ (2倍)"; } 
                    else if (rand <= 49) { multiplier = 2; const others = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; const resSyms = ["🍒", others[Math.floor(Math.random()*others.length)], others[Math.floor(Math.random()*others.length)]]; resSyms.sort(() => Math.random() - 0.5); symbolResult = resSyms.join(" | "); msgResult = "チェリー出現！ (2倍)"; } 
                    else { multiplier = 0; const others = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1 = others[Math.floor(Math.random()*others.length)], r2 = others[Math.floor(Math.random()*others.length)], r3 = others[Math.floor(Math.random()*others.length)]; while (r1 === r2 && r2 === r3) r3 = others[Math.floor(Math.random()*others.length)]; symbolResult = `${r1} | ${r2} | ${r3}`; msgResult = "はずれ！"; }
                    
                    const winAmount = betAmount * multiplier;
                    newMoney += winAmount;
                    
                    if (pData) await supabase.from('players').update({ money: newMoney, slot_count: newCount }).eq('account_id', senderId);
                    else await supabase.from('players').insert({ account_id: senderId, money: newMoney, debt: 0, slot_count: newCount });
                    
                    return await sendMessage(roomId, `${makeRp(senderId, roomId, msgId)}\n🎰 スロット結果 🎰\n【 ${symbolResult} 】\n${msgResult}\n賭け金: ${betAmount} ➡ 獲得: ${winAmount} コイン\n(残り回数: ${3 - newCount}回)`);
                }
            }

            // --- 丁半ゲーム ---
            if (!chState[roomId]) chState[roomId] = { state: 'IDLE', players: [] };
            let ch = chState[roomId];

            if (body.trim() === '/chouhan' && gambleActive) {
                if (ch.state !== 'IDLE') return;
                ch.state = 'RECRUITING';
                ch.host = senderId;
                ch.players = [{ aid: senderId, bet: 0, choice: null }];
                await sendTempMessage(roomId, `[info][title]🎲 丁半ゲーム募集開始[/title]参加者は /join chouhan と入力！(現在 1人)\n※2人以上で開始可能。\nホスト([piconname:${senderId}])は /startchouhan で強制開始。\n※1分経過で自動進行します。[/info]`);
                startTimer(roomId, 60000);
                return;
            }

            if (body.trim() === '/join chouhan' && gambleActive) {
                if (ch.state !== 'RECRUITING') return;
                if (ch.players.find(p => p.aid === senderId)) return;
                ch.players.push({ aid: senderId, bet: 0, choice: null });
                return await sendMessage(roomId, `[info]🎲 [piconname:${senderId}] が丁半に参加しました！ (現在 ${ch.players.length}人)[/info]`);
            }

            if (body.trim() === '/startchouhan' && gambleActive) {
                if (ch.state !== 'RECRUITING' || ch.host !== senderId) return;
                if (ch.players.length < 2) return await sendTempMessage(roomId, `[info]丁半ゲームは2人以上でないと開始できません。[/info]`);
                ch.state = 'BETTING';
                await sendTempMessage(roomId, `[info][title]ベット受付開始[/title]ホストが強制開始しました！\n参加者は /bet 掛け金 でベットしてください。(1分以内)[/info]`);
                startTimer(roomId, 60000);
                return;
            }

            if (body.trim() === '/leave' && gambleActive) {
                if (ch.state !== 'IDLE') {
                    let pIndex = ch.players.findIndex(p => p.aid === senderId);
                    if (pIndex !== -1) {
                        let p = ch.players[pIndex];
                        ch.players.splice(pIndex, 1);
                        if (p.bet > 0) await supabase.from('players').update({ money: myMoney + p.bet }).eq('account_id', p.aid);
                        await sendTempMessage(roomId, `[info][piconname:${senderId}] が退出しました。${p.bet > 0 ? '(掛け金は返還されました)' : ''}[/info]`);
                        
                        if (ch.players.length === 0) {
                            if (ch.timeoutId) clearTimeout(ch.timeoutId);
                            ch.state = 'IDLE';
                            return await sendTempMessage(roomId, `[info]参加者がいなくなったため、丁半ゲームを中止します。[/info]`);
                        }
                        if (ch.state === 'BETTING' && ch.players.length >= 2 && ch.players.every(pl => pl.bet > 0)) {
                            await moveToChoosing(roomId);
                        } else if (ch.state === 'CHOOSING' && ch.players.length >= 2 && ch.players.every(pl => pl.choice)) {
                            await resolveChouhan(roomId);
                        }
                    }
                }
                return;
            }

            const betMatch = body.match(/(^|\n)\/bet\s+([0-9]+)/);
            if (betMatch && gambleActive) {
                if (ch.state !== 'BETTING') return;
                let p = ch.players.find(p => p.aid === senderId);
                if (!p || p.bet > 0) return; 
                
                let betAmount = parseInt(betMatch[2], 10);
                if (betAmount <= 0) return;
                if (myMoney < betAmount) return await sendTempMessage(roomId, `${makeRp(senderId, roomId, msgId)} お金が足りません！`);
                
                await supabase.from('players').update({ money: myMoney - betAmount }).eq('account_id', senderId);
                p.bet = betAmount;
                await sendTempMessage(roomId, `[info][piconname:${senderId}] が ${betAmount} コインをベットしました！[/info]`);
                
                if (ch.players.length >= 2 && ch.players.every(pl => pl.bet > 0)) await moveToChoosing(roomId);
                return;
            }

            if ((body.trim() === '/chou' || body.trim() === '/han') && gambleActive) {
                if (ch.state !== 'CHOOSING') return;
                let p = ch.players.find(p => p.aid === senderId);
                if (!p || p.choice) return;
                
                p.choice = body.trim() === '/chou' ? 'chou' : 'han';
                let choiceName = p.choice === 'chou' ? '丁' : '半';
                await sendTempMessage(roomId, `[info][piconname:${senderId}] が「${choiceName}」を選択しました！[/info]`);
                
                if (ch.players.length >= 2 && ch.players.every(pl => pl.choice)) await resolveChouhan(roomId);
                return;
            }

            // --- コイン付与 (コマンド以外の通常発言) ---
            if (gambleActive && !body.trim().startsWith('/')) {
                if (pData) await supabase.from('players').update({ money: myMoney + 1 }).eq('account_id', senderId);
                else await supabase.from('players').insert({ account_id: senderId, money: 1, debt: 0, slot_count: 0 });
            }

        } catch (error) { console.error(error); }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;
