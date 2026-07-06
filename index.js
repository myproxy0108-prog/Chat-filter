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
const chState = {}; // 丁半
const ccState = {}; // チンチロ

const initBot = async () => {
    try {
        const { data } = await supabase.from('config').select('value').eq('key', 'gamble_active').single();
        if (data) gambleActive = data.value === 'true';
    } catch (e) {}
};
initBot();

const getTodayStr = () => new Date(Date.now() + 9 * 3600000).toISOString().split('T')[0];
const getThisMonthStr = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);

const verifySignature = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    if (!sig) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return sig === expected;
};

// --- 自動返済機能付き加算 ---
const addMoneyWithRepay = async (aid, amount) => {
    const { data } = await supabase.from('players').select('*').eq('account_id', aid).single();
    let money = data ? data.money : 0; 
    let debt = data ? (data.debt || 0) : 0;
    
    if (debt > 0 && amount > 0) {
        let repay = Math.min(debt, amount);
        debt -= repay; amount -= repay; 
    }
    money += amount;
    
    if (data) await supabase.from('players').update({ money, debt }).eq('account_id', aid);
    else await supabase.from('players').insert({ account_id: aid, money, debt });
    return { money, debt };
};

// --- メッセージ操作 ---
const sendTempMessage = async (roomId, text, ms = 60000) => {
    try {
        const res = await cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`);
        if (res && res.data && res.data.message_id) setTimeout(() => { cw.delete(`/rooms/${roomId}/messages/${res.data.message_id}`).catch(()=>{}); }, ms);
    } catch(e) {}
};
const sendMessage = (roomId, text) => cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`).catch(()=>{});
const deleteMessage = (roomId, msgId) => cw.delete(`/rooms/${roomId}/messages/${msgId}`).catch(()=>{});

// --- 防衛・パトロール ---
const checkSpam = (aid) => {
    const now = Date.now();
    if (!spamRecords[aid]) spamRecords[aid] = [];
    spamRecords[aid].push(now);
    spamRecords[aid] = spamRecords[aid].filter(t => now - t <= 5000);
    if (spamRecords[aid].length >= 10) { spamRecords[aid] = []; return true; }
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

// --- ゲームタイマー管理 ---
const startTimer = (roomId, type, ms = 60000) => {
    const st = (type === 'ch') ? chState[roomId] : ccState[roomId];
    if (st.timeoutId) clearTimeout(st.timeoutId);
    st.timeoutId = setTimeout(() => handleTimeout(roomId, type), ms);
};

const handleTimeout = async (roomId, type) => {
    try {
        const st = (type === 'ch') ? chState[roomId] : ccState[roomId];
        if (!st || st.state === 'IDLE') return;

        if (st.state === 'RECRUITING') {
            if (st.players.length >= 2) {
                st.state = 'BETTING';
                await sendTempMessage(roomId, `[info]⏳ 募集終了！\n参加者は /bet 掛け金 でベットしてください。(制限1分)[/info]`);
                startTimer(roomId, type, 60000);
            } else {
                await sendTempMessage(roomId, `[info]参加者が2人未満のため、ゲームを中止します。[/info]`);
                if (type === 'ch') chState[roomId] = { state: 'IDLE', players: [] };
                else ccState[roomId] = { state: 'IDLE', players: [] };
            }
        } else if (st.state === 'BETTING' || st.state === 'CHOOSING' || st.state === 'ROLLING') {
            let kicked = []; let active = [];
            for (let p of st.players) {
                if ((st.state === 'BETTING' && p.bet === 0) || (st.state === 'CHOOSING' && !p.choice) || (st.state === 'ROLLING' && !p.rollResult && p.aid !== st.host)) {
                    kicked.push(p.aid);
                    if (p.bet > 0) await addMoneyWithRepay(p.aid, p.bet);
                } else active.push(p);
            }
            st.players = active;
            if (kicked.length > 0) await sendTempMessage(roomId, `[info]⏳ タイムアウトにより以下を退出・返金しました。\n${kicked.map(aid=>`[piconname:${aid}]`).join(' ')}[/info]`);
            
            if (st.players.length < 2) {
                for (let p of st.players) if (p.bet > 0) await addMoneyWithRepay(p.aid, p.bet);
                await sendTempMessage(roomId, `[info]人数不足のため中止し全額返金しました。[/info]`);
                if (type === 'ch') chState[roomId] = { state: 'IDLE', players: [] };
                else ccState[roomId] = { state: 'IDLE', players: [] };
            } else if (st.state === 'BETTING') {
                if (type === 'ch') {
                    st.state = 'CHOOSING';
                    await sendTempMessage(roomId, `[info][title]🎲 丁半 選択[/title]全員ベット完了！\n/chou または /han を予想してください。(制限1分)[/info]`);
                } else {
                    st.state = 'ROLLING';
                    await sendTempMessage(roomId, `[info][title]🎲 チンチロ 振るフェーズ[/title]全員ベット完了！\n親以外は /roll でサイコロを振ってください。(制限1分)[/info]`);
                }
                startTimer(roomId, type, 60000);
            } else {
                if (type === 'ch') await resolveChouhan(roomId);
                else await resolveChinchiro(roomId);
            }
        }
    } catch (e) {}
};

// --- ゲームロジック ---
const getChinchiroResult = () => {
    for (let i = 0; i < 3; i++) {
        let d = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1].sort((a,b)=>a-b);
        if (d[0]===1 && d[1]===1 && d[2]===1) return { dice: d, name: "ピンゾロ", rank: 6, score: 1, mult: 5 };
        if (d[0]===d[1] && d[1]===d[2]) return { dice: d, name: `${d[0]}の嵐`, rank: 5, score: d[0], mult: 3 };
        if (d[0]===4 && d[1]===5 && d[2]===6) return { dice: d, name: "シゴロ", rank: 4, score: 6, mult: 2 };
        if (d[0]===1 && d[1]===2 && d[2]===3) return { dice: d, name: "ヒフミ", rank: 0, score: 0, mult: -2 };
        if (d[0]===d[1]) return { dice: d, name: `${d[2]}の目`, rank: 2, score: d[2], mult: 1 };
        if (d[1]===d[2]) return { dice: d, name: `${d[0]}の目`, rank: 2, score: d[0], mult: 1 };
        if (d[0]===d[2]) return { dice: d, name: `${d[1]}の目`, rank: 2, score: d[1], mult: 1 };
    }
    return { dice: [0,0,0], name: "目なし", rank: 1, score: 0, mult: 1 };
};

const resolveChinchiro = async (roomId) => {
    let cc = ccState[roomId]; if (!cc) return;
    if (cc.timeoutId) clearTimeout(cc.timeoutId);
    let parentRoll = getChinchiroResult();
    let msg = `[info][title]🎲 チンチロリン 結果発表[/title]【 親 ([piconname:${cc.host}])の出目 】\n[ ${parentRoll.dice.join(', ')} ] ➡ 『 ${parentRoll.name} 』\n[hr]【 プレイヤー結果 】\n`;

    for (let p of cc.players) {
        if (p.aid === cc.host) continue;
        let res = p.rollResult || { rank: 1, name: "欠席", mult: 1, score: 0, dice: [0,0,0] };
        let isWin = false, isDraw = false;
        
        if (res.rank > parentRoll.rank) isWin = true;
        else if (res.rank < parentRoll.rank) isWin = false;
        else {
            if (res.score > parentRoll.score) isWin = true;
            else if (res.score < parentRoll.score) isWin = false;
            else isDraw = true;
        }

        if (isDraw) {
            await addMoneyWithRepay(p.aid, p.bet);
            msg += `[piconname:${p.aid}]: [${res.dice.join(',')}] ${res.name} ➡ 😐 引き分け (返金)\n`;
        } else if (isWin) {
            let wMult = res.mult > 0 ? res.mult : 1; 
            await addMoneyWithRepay(p.aid, p.bet + (p.bet * wMult));
            msg += `🎉 [piconname:${p.aid}]: [${res.dice.join(',')}] ${res.name} ➡ 勝ち！ (+${p.bet * wMult})\n`;
        } else {
            msg += `💀 [piconname:${p.aid}]: [${res.dice.join(',')}] ${res.name} ➡ 負け\n`;
        }
    }
    await sendMessage(roomId, msg + "[/info]");
    ccState[roomId] = { state: 'IDLE', players: [] };
    await supabase.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const resolveChouhan = async (roomId) => {
    let ch = chState[roomId]; if (!ch) return;
    if (ch.timeoutId) clearTimeout(ch.timeoutId);
    let d1 = Math.floor(Math.random()*6)+1, d2 = Math.floor(Math.random()*6)+1;
    let sum = d1 + d2;
    let res = (sum % 2 === 0) ? 'chou' : 'han';
    let msg = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1}, ${d2} (合計: ${sum})\n➡ 『 ${res === 'chou' ? '丁(偶数)' : '半(奇数)'} 』の勝ち！\n[hr]`;

    for (let p of ch.players) {
        if (p.choice === res) {
            await addMoneyWithRepay(p.aid, p.bet * 2);
            msg += `🎉 [piconname:${p.aid}]: 的中！ (+${p.bet * 2} コイン)\n`;
        } else {
            msg += `💀 [piconname:${p.aid}]: はずれ...\n`;
        }
    }
    await sendMessage(roomId, msg + "[/info]");
    chState[roomId] = { state: 'IDLE', players: [] };
    await supabase.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

// --- 深夜リセット ---
const checkDailyReset = async (roomId) => {
    try {
        const todayStr = getTodayStr();
        if (localLastResetDate === todayStr) return; 
        const { data } = await supabase.from('config').select('value').eq('key', 'last_reset_date').single();
        if (data && data.value === todayStr) { localLastResetDate = todayStr; return; }

        localLastResetDate = todayStr;
        await supabase.from('players').update({ slot_count: 0, work_date: null, skill_date: null, work_limit: 5, msg_count: 0 }).neq('account_id', '0');
        await supabase.from('config').upsert({ key: 'last_reset_date', value: todayStr });
        
        let msg = `[info][title]🔄 日替わり更新[/title]深夜0時です。\nスロット回数と職業・仕事制限がリセットされました！\n[hr]`;

        const { data: lotData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
        let tickets = lotData ? JSON.parse(lotData.value) : [];
        if (tickets.length > 0) {
            let winNum = Math.floor(Math.random() * 9999) + 1;
            msg += `[title]🎯 宝くじ抽選結果[/title]当選番号は...【 ${winNum} 】！\n[hr]`;
            let payouts = {}; let winners = [];
            const getPrize = (num, win) => {
                if (num === win) return { p: 30000, n: '🥇 1等' };
                let prev = win - 1 < 1 ? 9999 : win - 1; let next = win + 1 > 9999 ? 1 : win + 1;
                if (num === prev || num === next) return { p: 15000, n: '🥈 前後賞' };
                if (num % 1000 === win % 1000) return { p: 10000, n: '🥈 2等' }; 
                if (num % 100 === win % 100) return { p: 5000, n: '🥉 3等' };    
                if (num % 10 === win % 10) return { p: 1000, n: '🏅 4等' };      
                return null;
            };
            
            for (let t of tickets) {
                let r = getPrize(t.num, winNum);
                if (r) { winners.push({ aid: t.aid, num: t.num, ...r }); payouts[t.aid] = (payouts[t.aid] || 0) + r.p; }
            }
            if (winners.length > 0) {
                for (let aid in payouts) await addMoneyWithRepay(aid, payouts[aid]);
                winners.sort((a, b) => b.p - a.p);
                for (let w of winners) msg += `[piconname:${w.aid}] 様: 予想[${w.num}] ➡ ${w.n} (+${w.p} コイン)\n`;
            } else msg += `本日の当選者はいませんでした。\n`;
            await supabase.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
        }
        if (roomId) await sendMessage(roomId, msg + `[/info]`);
    } catch (e) {}
};

// --- Webhook メイン ---
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid');
    res.status(200).send('OK'); 

    const event = req.body.webhook_event;
    if (!event || req.body.webhook_event_type !== 'message_created') return;

    const roomId = event.room_id, body = event.body || "", senderId = event.account_id.toString(), msgId = event.message_id;
    const today = getTodayStr(), thisMonth = getThisMonthStr();

    (async () => {
        try {
            const rpMatch = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const repliedAid = rpMatch ? rpMatch[1] : null;

            // 1. ブラックリスト判定
            const { data: isBanned } = await supabase.from('blacklist').select('*').eq('account_id', senderId).single();
            if (isBanned) { 
                await updateRoomMembers(roomId, [senderId], 'readonly'); 
                await deleteMessage(roomId, msgId); return; 
            }
            runPatrol(roomId); checkDailyReset(roomId);

            // 2. スパム検知
            if (checkSpam(senderId) && !(await isUserAdmin(roomId, senderId))) {
                await updateRoomMembers(roomId, [senderId], 'readonly');
                return sendTempMessage(roomId, `[info]⚠️ [piconname:${senderId}] 連投につき閲覧制限しました。[/info]`);
            }

            // 3. 仕事回数のサイレント回復
            const { data: pData } = await supabase.from('players').select('*').eq('account_id', senderId).single();
            if (gambleActive && !body.startsWith('/')) {
                let mc = (pData ? pData.msg_count || 0 : 0) + 1;
                let wl = pData ? pData.work_limit || 5 : 5;
                if (mc >= (Math.floor(Math.random() * 21) + 30)) { mc = 0; if (wl < 10) wl++; }
                if (pData) await supabase.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', senderId);
                else await supabase.from('players').insert({ account_id: senderId, money: 0, work_limit: 5, msg_count: 1 });
            }

            // --- コマンド ---
            if (body.trim() === '/help-gya') {
                const h = `[info][title]🎰 カジノ＆ライフ 総合案内[/title]
[b]【 🏦 銀行・ステータス 】[/b]
/status : 自分の所持金・借金・職業などを確認
/give [金額] : 返信で相手に送金 (※10%の税金が引かれます)
/debt [金額] : 借金する (1ヶ月の上限 5000コイン)
/money-rank : 純資産ランキング (5分で消滅)

[b]【 💼 職業・スキル 】[/b]
/job : 求人一覧と給与を確認
/job [職業名] : 指定の職業へ転職する
/work : 給料をもらう (10分に1回, 1日5回)
/catch または /goal : 特殊能力 (1日1回)

[b]【 🎰 カジノゲーム 】[/b]
/slot [掛金] : スロット (1日3回, 10分間隔)
/buy-lot [数字] : 宝くじ購入 (100コイン、0時抽選)
/chouhan : 丁半ゲーム募集 (3分間隔)
/cc : チンチロリン募集 (3分間隔)
/roll : チンチロリンでサイコロを振る

[b]【 👑 管理者専用 】[/b]
/take [金額] : 相手にお金を特別付与
/st-gya, /fi-gya : 有効/無効化
/blacklist, /reblacklist : 追放・制限の管理
/remove-rank : ランキング除外[/info]`;
                return await sendTempMessage(roomId, h, 120000);
            }

            // --- 👑 管理者コマンド ---
            if (/(^|\n)\/take\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
                let targetAid = repliedAid; let amount = 0;
                if (targetAid) {
                    const match = body.match(/(^|\n)\/take\s+([0-9]+)/);
                    if (match) amount = parseInt(match[2], 10);
                } else {
                    const match = body.match(/(^|\n)\/take\s+([0-9]+)\s+([0-9]+)/);
                    if (match) { targetAid = match[2]; amount = parseInt(match[3], 10); }
                }
                if (!targetAid || isNaN(amount) || amount <= 0) return;
                await addMoneyWithRepay(targetAid, amount);
                return await sendTempMessage(roomId, `[info]👑 [piconname:${targetAid}] 様へ ${amount} コイン付与しました。[/info]`);
            }

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
                        await sendTempMessage(roomId, `[info][piconname:${targetAid}] ランキングから除外しました。[/info]`);
                    }
                    return await supabase.from('config').upsert({ key: 'rank_excluded', value: JSON.stringify(ex) });
                }

                if (cmd === 'add') {
                    const { data: ex } = await supabase.from('blacklist').select('account_id').eq('account_id', targetAid);
                    if (ex && ex.length > 0) return await sendTempMessage(roomId, `[info]⚠️ 既に登録されています。[/info]`);
                    await supabase.from('blacklist').insert({ account_id: targetAid });
                    await updateRoomMembers(roomId, [targetAid], 'readonly');
                    return await sendTempMessage(roomId, `[info]🚫 [piconname:${targetAid}] をBL登録し閲覧のみに変更しました。[/info]`);
                } else if (cmd === 'remove') {
                    await supabase.from('blacklist').delete().eq('account_id', targetAid);
                    return await sendTempMessage(roomId, `[info]✅ [piconname:${targetAid}] をBLから解除しました。[/info]`);
                } else if (cmd === 'list') {
                    const { data } = await supabase.from('blacklist').select('account_id');
                    const ls = data && data.length > 0 ? data.map(d => `[piconname:${d.account_id}] (ID: ${d.account_id})`).join('\n') : "なし";
                    return await sendTempMessage(roomId, `[info][title]📜 ブラックリスト一覧[/title]${ls}\n[hr]※1分で自動消滅[/info]`);
                }
            }

            if (body.startsWith('/st-gya') && await isUserAdmin(roomId, senderId)) {
                gambleActive = true; await supabase.from('config').upsert({ key: 'gamble_active', value: 'true' });
                return sendMessage(roomId, `[info]🎰 カジノ＆ライフ機能 ON[/info]`);
            }
            if (body.startsWith('/fi-gya') && await isUserAdmin(roomId, senderId)) {
                gambleActive = false; await supabase.from('config').upsert({ key: 'gamble_active', value: 'false' });
                return sendMessage(roomId, `[info]🚫 カジノ＆ライフ機能 OFF[/info]`);
            }

            let myMoney = pData ? pData.money : 0;
            let myDebt = pData ? (pData.debt || 0) : 0;
            let myJob = pData ? (pData.job || 'サラリーマン') : 'サラリーマン';
            let currentMonthlyDebt = (pData && pData.debt_month === thisMonth) ? (pData.monthly_debt || 0) : 0;

            // --- 🏦 借金・送金 ---
            const debtMatch = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (debtMatch && gambleActive) {
                let amt = parseInt(debtMatch[2], 10);
                if (amt > 0) {
                    if (currentMonthlyDebt + amt > 5000) return await sendTempMessage(roomId, `[info]⚠️ 月間の借金上限(5000)を超えています！\n今月は既に ${currentMonthlyDebt} コイン借りています。[/info]`);
                    if (pData) await supabase.from('players').update({ money: myMoney + amt, debt: myDebt + amt, monthly_debt: currentMonthlyDebt + amt, debt_month: thisMonth }).eq('account_id', senderId);
                    else await supabase.from('players').insert({ account_id: senderId, money: amt, debt: amt, slot_count: 0, monthly_debt: amt, debt_month: thisMonth });
                    return await sendTempMessage(roomId, `[info]💳 [piconname:${senderId}] 様\n${amt} コインを借金しました。\n(今月の借金可能枠: 残り ${5000 - (currentMonthlyDebt + amt)} コイン)[/info]`);
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
                if (avMoney < amount) return await sendTempMessage(roomId, `⚠️ 送金枠不足！\n(借金があるため、送れる純資産は ${avMoney} コインのみです)`);
                
                let tax = Math.floor(amount * 0.10); let receiveAmt = amount - tax;
                await supabase.from('players').update({ money: myMoney - amount }).eq('account_id', senderId);
                const { data: rec } = await supabase.from('players').select('*').eq('account_id', targetAid).single();
                if (rec) await supabase.from('players').update({ money: rec.money + receiveAmt }).eq('account_id', targetAid);
                else await supabase.from('players').insert({ account_id: targetAid, money: receiveAmt, debt: 0, slot_count: 0 });
                
                return await sendTempMessage(roomId, `[info]🎁 [piconname:${senderId}] ➡ [piconname:${targetAid}]\n${amount} コインを送金\n[hr]※システム税(-${tax})を引かれ、相手には ${receiveAmt} 届きました。[/info]`);
            }

            // --- 📊 ステータス・ランキング ---
            if (body.trim() === '/status') {
                if (pData) {
                    const remSlot = Math.max(0, 3 - pData.slot_count);
                    const dStr = myDebt > 0 ? `\n💳 借金: -${myDebt} コイン` : '';
                    return sendTempMessage(roomId, `[info][title]📊 プレイヤー情報[/title][piconname:${senderId}] 様\n\n💰 所持金: ${myMoney} コイン${dStr}\n👔 職業: ${myJob}\n🎰 スロット残り: ${remSlot}回 / 💼 仕事残り: ${pData.work_limit}回\n[hr]※1分で消去されます[/info]`);
                } else return sendTempMessage(roomId, `[info]データがありません。[/info]`);
            }

            if (body.trim() === '/money-rank') {
                const { data: exD } = await supabase.from('config').select('value').eq('key', 'rank_excluded').single();
                let ex = exD ? JSON.parse(exD.value) : [];
                const { data: list } = await supabase.from('players').select('*');
                let filtered = list ? list.filter(d => !ex.includes(d.account_id)) : [];
                
                filtered.sort((a, b) => ((b.money || 0) - (b.debt || 0)) - ((a.money || 0) - (a.debt || 0)));
                const s = filtered.slice(0, 10).map((d, i) => {
                    let net = (d.money || 0) - (d.debt || 0);
                    let dStr = (d.debt && d.debt > 0) ? ` (所持:${d.money} 借金:-${d.debt})` : '';
                    let jStr = d.job ? `[${d.job}]` : `[サラリーマン]`;
                    let medal = i === 0 ? "🥇" : (i === 1 ? "🥈" : (i === 2 ? "🥉" : "🔹"));
                    return `${medal} ${i+1}位: [piconname:${d.account_id}]\n　純資産: ${net} ${dStr} ${jStr}`;
                }).join('\n[hr]');
                
                return await sendTempMessage(roomId, `[info][title]👑 純資産ランキング TOP10[/title]${s || 'データなし'}\n[hr]※5分で消滅します[/info]`, 300000);
            }

            // --- 💼 職業機能 ---
            if (/(^|\n)\/job(\s|$)/.test(body) && gambleActive) {
                const jobMsg = `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 [b]サラリーマン[/b] (費用: 0)
 ▶ /work (100〜500) ※10%ミス0

🏛️ [b]公務員[/b] (費用: 2000)
 ▶ /work (300〜500)

🚓 [b]警察官[/b] (費用: 3000)
 ▶ /work (300〜700)
 ▶ /catch (30%で逮捕! 800)

⚽ [b]プロスポーツ選手[/b] (費用: 5000)
 ▶ /work (500〜1000)
 ▶ /goal (30%でゴール! 1000)
[hr]※転職コマンド: /job 役職名[/info]`;
                return await sendTempMessage(roomId, jobMsg, 60000);
            }

            const cJobMatch = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (cJobMatch && gambleActive) {
                const jn = cJobMatch[2]; const costs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000};
                if (myJob === jn) return await sendTempMessage(roomId, `⚠️ すでに ${jn} です！`);
                if (myMoney < costs[jn]) return await sendTempMessage(roomId, `⚠️ お金が足りません！(費用: ${costs[jn]})`);
                
                if (pData) await supabase.from('players').update({ job: jn, money: myMoney - costs[jn] }).eq('account_id', senderId);
                else await supabase.from('players').insert({ account_id: senderId, job: jn, money: -costs[jn] });
                return await sendTempMessage(roomId, `[info]🎉 [piconname:${senderId}] 様\n${jn} に転職しました！ (-${costs[jn]})[/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive) {
                if (!pData) return;
                if (pData.work_limit <= 0) return sendTempMessage(roomId, `今日の仕事回数が上限(5回)です。`);
                if (Date.now() - (pData.last_work_time || 0) < 600000) return sendTempMessage(roomId, `休憩中です(10分間隔)。`);
                
                let earn = 0; let msg = "";
                if (myJob === 'サラリーマン') {
                    if (Math.random() < 0.1) { earn = 0; msg = "ミスをしてしまい、本日の給料は 0 コインに...😭"; } 
                    else { earn = Math.floor(Math.random()*401)+100; msg = `真面目に働き、 ${earn} コイン稼ぎました！💼`; }
                } else if (myJob === '公務員') { earn = Math.floor(Math.random()*201)+300; msg = `安定した仕事をこなし、 ${earn} コイン稼ぎました！🏛️`; }
                else if (myJob === '警察官') { earn = Math.floor(Math.random()*401)+300; msg = `街の平和を守り、 ${earn} コイン稼ぎました！🚓`; }
                else if (myJob === 'プロスポーツ選手') { earn = Math.floor(Math.random()*501)+500; msg = `試合で大活躍し、 ${earn} コイン稼ぎました！⚽`; }
                
                await supabase.from('players').update({ last_work_time: Date.now(), work_limit: pData.work_limit - 1 }).eq('account_id', senderId);
                await addMoneyWithRepay(senderId, earn);
                return await sendTempMessage(roomId, `[info]💼 [piconname:${senderId}]\n${msg} (残り${pData.work_limit - 1}回)[/info]`);
            }

            if ((/(^|\n)\/catch\b/.test(body) || /(^|\n)\/goal\b/.test(body)) && gambleActive) {
                if (!pData) return;
                let isCatch = /(^|\n)\/catch\b/.test(body);
                if (isCatch && myJob !== '警察官') return sendTempMessage(roomId, `⚠️ 警察官専用です`);
                if (!isCatch && myJob !== 'プロスポーツ選手') return sendTempMessage(roomId, `⚠️ プロ専用です`);
                if (pData.skill_date === today) return sendTempMessage(roomId, `⚠️ 特殊能力は1日1回までです`);

                let succ = Math.random() < 0.3; let earn = 0; let msg = "";
                if (isCatch) {
                    if (succ) { earn = 800; msg = `犯人を逮捕！報酬 ${earn} 獲得！🚨`; } else msg = `犯人を逃しました...🏃‍♂️`;
                } else {
                    if (succ) { earn = 1000; msg = `スーパーゴール！スポンサーから ${earn} 獲得！🥅`; } else msg = `シュートは外れました...🤦‍♂️`;
                }
                await supabase.from('players').update({ skill_date: today }).eq('account_id', senderId);
                await addMoneyWithRepay(senderId, earn);
                return await sendTempMessage(roomId, `[info]✨ [piconname:${senderId}]\n${msg}[/info]`);
            }

            // --- 🎟️ 宝くじ ---
            const lotMatch = body.match(/(^|\n)\/buy-lot\s+([0-9]+)/);
            if (lotMatch && gambleActive) {
                const num = parseInt(lotMatch[2], 10);
                if (num >= 1 && num <= 9999) {
                    const { data: lData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = lData ? JSON.parse(lData.value) : [];
                    if (tks.some(t => t.num === num)) return sendTempMessage(roomId, `⚠️ 番号【 ${num} 】は既に買われています！`);
                    if (myMoney < 100) return sendTempMessage(roomId, `⚠️ お金が足りません！宝くじは100コインです。`);
                    
                    await supabase.from('players').update({ money: myMoney - 100 }).eq('account_id', senderId);
                    tks.push({ aid: senderId, num: num });
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tks) });
                    return await sendTempMessage(roomId, `[info]🎟 [piconname:${senderId}] 様\n宝くじ【 ${num} 】を購入しました！\n(抽選は深夜0時)[/info]`);
                }
            }

            // --- 🎰 スロット ---
            const slotMatch = body.match(/(^|\n)\/slot\s+([0-9]+)/);
            if (slotMatch && gambleActive) {
                const betAmt = parseInt(slotMatch[2], 10);
                if (betAmt > 0) {
                    if (myMoney < betAmt) return sendTempMessage(roomId, `⚠️ お金が足りません！`);
                    if (pData && pData.slot_count >= 3) return sendTempMessage(roomId, `⚠️ スロットは1日3回までです！`);
                    if (pData && (Date.now() - (pData.last_slot_time || 0) < 600000)) return sendTempMessage(roomId, `⚠️ 休憩中(10分間隔)です！`);
                    
                    await supabase.from('players').update({ money: myMoney - betAmt }).eq('account_id', senderId);
                    
                    const rand = Math.floor(Math.random() * 100);
                    let mlt = 0, sym = "", res = "";
                    if (rand === 0) { mlt = 100; sym = "🐉 | 🐉 | 🐉"; res = "🔥 超大当たり！！！ (100倍)"; } 
                    else if (rand <= 3) { mlt = 10; sym = "7️⃣ | 7️⃣ | 7️⃣"; res = "✨ 大当たり！ (10倍)"; } 
                    else if (rand <= 9) { mlt = 3; let s = ["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sym = `${s} | ${s} | ${s}`; res = "🎉 当たり！ (3倍)"; } 
                    else if (rand <= 19) { mlt = 2; let s = ["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sym = `${s} | ${s} | ${s}`; res = "🎉 当たり！ (2倍)"; } 
                    else if (rand <= 29) { mlt = 2; let s = ["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sym = `${s} | ${s} | ${s}`; res = "🍇 フルーツ揃い！ (2倍)"; } 
                    else if (rand <= 49) { mlt = 2; let oth = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1 = oth[Math.floor(Math.random()*oth.length)], s2 = oth[Math.floor(Math.random()*oth.length)]; let a = ["🍒", s1, s2].sort(()=>Math.random()-0.5); sym = a.join(" | "); res = "🍒 チェリー出現！ (2倍)"; } 
                    else { mlt = 0; let oth = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=oth[Math.floor(Math.random()*oth.length)], r2=oth[Math.floor(Math.random()*oth.length)], r3=oth[Math.floor(Math.random()*oth.length)]; while(r1===r2 && r2===r3) r3=oth[Math.floor(Math.random()*oth.length)]; sym = `${r1} | ${r2} | ${r3}`; res = "💀 はずれ..."; }
                    
                    let wAmt = betAmt * mlt;
                    await supabase.from('players').update({ slot_count: (pData?pData.slot_count:0)+1, last_slot_time: Date.now() }).eq('account_id', senderId);
                    if (wAmt > 0) await addMoneyWithRepay(senderId, wAmt);
                    
                    return await sendMessage(roomId, `[info][title]🎰 SLOT MACHINE[/title]${makeRp(senderId, roomId, msgId)}\n[hr]　▶ [ ${sym} ] ◀　\n[hr]${res}\n\n賭け金: ${betAmt} ➡ 獲得: ${wAmt} コイン\n(残り回数: ${3 - ((pData?pData.slot_count:0)+1)}回)[/info]`);
                }
            }

            // --- 🎲 ゲーム共通判定 ---
            if (!chState[roomId]) chState[roomId] = { state: 'IDLE', players: [] };
            if (!ccState[roomId]) ccState[roomId] = { state: 'IDLE', players: [] };
            let ch = chState[roomId], cc = ccState[roomId];
            
            const { data: lastG } = await supabase.from('config').select('value').eq('key', 'last_game_time').single();
            const gCD = (Date.now() - parseInt(lastG ? lastG.value : 0)) < 180000; // 3分間隔

            if ((body.trim() === '/chouhan' || body.trim() === '/cc') && gambleActive) {
                if (ch.state !== 'IDLE' || cc.state !== 'IDLE') return sendTempMessage(roomId, `⚠️ 他のゲームが進行中です`);
                if (gCD) return sendTempMessage(roomId, `⚠️ ゲームは3分間隔です。もう少しお待ちください。`);
                
                if (body.trim() === '/chouhan') {
                    ch.state = 'RECRUITING'; ch.host = senderId; ch.players = [{ aid: senderId, bet: 0, choice: null }];
                    sendTempMessage(roomId, `[info][title]🎲 丁半ゲーム募集[/title]参加者は /join chouhan と入力！(現在 1人)\n※2人以上で開始可能。\nホスト([piconname:${senderId}])は /startchouhan で強制開始。\n※1分経過で自動進行します。[/info]`);
                    startTimer(roomId, 'ch');
                } else {
                    cc.state = 'RECRUITING'; cc.host = senderId; cc.players = [{ aid: senderId, bet: 0, rollResult: null }];
                    sendTempMessage(roomId, `[info][title]🎲 チンチロリン募集[/title]参加者は /join cc と入力！(現在 1人)\n※2人以上で開始可能。\nホスト([piconname:${senderId}])は /startcc で強制開始。\n※1分経過で自動進行します。[/info]`);
                    startTimer(roomId, 'cc');
                }
                return;
            }

            if (body.trim() === '/join chouhan' && ch.state === 'RECRUITING' && !ch.players.find(x=>x.aid===senderId)) {
                ch.players.push({ aid: senderId, bet: 0, choice: null });
                return sendMessage(roomId, `[info]🎲 [piconname:${senderId}] が丁半に参加！ (現在 ${ch.players.length}人)[/info]`);
            }
            if (body.trim() === '/join cc' && cc.state === 'RECRUITING' && !cc.players.find(x=>x.aid===senderId)) {
                cc.players.push({ aid: senderId, bet: 0, rollResult: null });
                return sendMessage(roomId, `[info]🎲 [piconname:${senderId}] がチンチロに参加！ (現在 ${cc.players.length}人)[/info]`);
            }

            if (body.trim() === '/startchouhan' && ch.state === 'RECRUITING' && ch.host === senderId) {
                if (ch.players.length < 2) return sendTempMessage(roomId, `⚠️ 2人以上でないと開始できません`);
                ch.state = 'BETTING'; sendTempMessage(roomId, `[info][title]ベット受付開始[/title]ホストが強制開始しました！\n参加者は /bet 掛け金 でベットしてください。(1分以内)[/info]`);
                startTimer(roomId, 'ch'); return;
            }
            if (body.trim() === '/startcc' && cc.state === 'RECRUITING' && cc.host === senderId) {
                if (cc.players.length < 2) return sendTempMessage(roomId, `⚠️ 2人以上でないと開始できません`);
                cc.state = 'BETTING'; sendTempMessage(roomId, `[info][title]ベット受付開始[/title]チンチロ開始！\n参加者は /bet 掛け金 でベットしてください。(1分以内)[/info]`);
                startTimer(roomId, 'cc'); return;
            }

            if (body.trim() === '/leave' && gambleActive) {
                if (ch.state !== 'IDLE') {
                    let idx = ch.players.findIndex(p => p.aid === senderId);
                    if (idx !== -1) {
                        let p = ch.players[idx]; ch.players.splice(idx, 1);
                        if (p.bet > 0) await addMoneyWithRepay(senderId, p.bet); 
                        sendTempMessage(roomId, `[info][piconname:${senderId}] 退出しました[/info]`);
                        if (ch.players.length === 0) { ch.state = 'IDLE'; return sendTempMessage(roomId, `[info]参加者0人のため中止[/info]`); }
                    }
                } else if (cc.state !== 'IDLE') {
                    let idx = cc.players.findIndex(p => p.aid === senderId);
                    if (idx !== -1) {
                        let p = cc.players[idx]; cc.players.splice(idx, 1);
                        if (p.bet > 0) await addMoneyWithRepay(senderId, p.bet); 
                        sendTempMessage(roomId, `[info][piconname:${senderId}] 退出しました[/info]`);
                        if (cc.players.length === 0) { cc.state = 'IDLE'; return sendTempMessage(roomId, `[info]参加者0人のため中止[/info]`); }
                    }
                }
                return;
            }

            const betMatch = body.match(/(^|\n)\/bet\s+([0-9]+)/);
            if (betMatch && gambleActive) {
                let b = parseInt(betMatch[2], 10);
                if (b > 0 && myMoney >= b) {
                    if (ch.state === 'BETTING') {
                        let plr = ch.players.find(x=>x.aid===senderId);
                        if (plr && plr.bet === 0) {
                            plr.bet = b; await supabase.from('players').update({ money: myMoney - b }).eq('account_id', senderId);
                            sendTempMessage(roomId, `[info][piconname:${senderId}] ${b} コインをベット！[/info]`);
                            if (ch.players.length >= 2 && ch.players.every(x=>x.bet>0)) { 
                                ch.state = 'CHOOSING'; sendTempMessage(roomId, `[info][title]🎲 丁半 選択[/title]全員ベット完了！\n/chou (丁) か /han (半) を予想してください。(制限1分)[/info]`); startTimer(roomId, 'ch'); 
                            }
                        }
                    } else if (cc.state === 'BETTING') {
                        let plr = cc.players.find(x=>x.aid===senderId);
                        if (plr && plr.bet === 0) {
                            plr.bet = b; await supabase.from('players').update({ money: myMoney - b }).eq('account_id', senderId);
                            sendTempMessage(roomId, `[info][piconname:${senderId}] ${b} コインをベット！[/info]`);
                            if (cc.players.length >= 2 && cc.players.every(x=>x.bet>0)) { 
                                cc.state = 'ROLLING'; sendTempMessage(roomId, `[info][title]🎲 チンチロ 振るフェーズ[/title]全員ベット完了！\n親(ホスト)以外は /roll でサイコロを振ってください。(制限1分)[/info]`); startTimer(roomId, 'cc'); 
                            }
                        }
                    }
                } else if (b > 0 && myMoney < b) return sendTempMessage(roomId, `⚠️ お金が足りません！`);
            }

            if ((body.trim() === '/chou' || body.trim() === '/han') && gambleActive && ch.state === 'CHOOSING') {
                let p = ch.players.find(x=>x.aid===senderId);
                if (p && !p.choice) {
                    p.choice = body.trim().slice(1); sendTempMessage(roomId, `[info][piconname:${senderId}] 「${p.choice==='chou'?'丁':'半'}」を選択しました！[/info]`);
                    if (ch.players.length >= 2 && ch.players.every(x=>x.choice)) resolveChouhan(roomId);
                }
            }

            if (body.trim() === '/roll' && gambleActive && cc.state === 'ROLLING') {
                let p = cc.players.find(x=>x.aid===senderId);
                if (p && !p.rollResult && senderId !== cc.host) {
                    p.rollResult = getChinchiroResult();
                    sendMessage(roomId, `[info]🎲 [piconname:${senderId}] の出目: ${p.rollResult.name}[/info]`);
                    if (cc.players.filter(x=>x.aid!==cc.host).every(x=>x.rollResult)) resolveChinchiro(roomId);
                }
            }

        } catch (error) { console.error(error); }
    })();
});

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Live V30 FINAL`));
}
module.exports = app;
