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

// --- メッセージ処理 ---
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

// --- 防衛・パトロール ---
const checkSpam = (accountId) => {
    const now = Date.now();
    if (!spamRecords[accountId]) spamRecords[accountId] = [];
    spamRecords[accountId].push(now);
    spamRecords[accountId] = spamRecords[accountId].filter(t => now - t <= 5000);
    if (spamRecords[accountId].length >= 10) { spamRecords[accountId] = []; return true; }
    return false;
};

const updateRoomMembers = async (roomId, targetIds, action = 'kick') => {
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
        const toKick = members.filter(m => blacklistedIds.includes(m.account_id.toString())).map(m => m.account_id.toString());
        if (toKick.length > 0) await updateRoomMembers(roomId, toKick, 'kick');
    } catch (e) {}
};

// --- 深夜0時リセット＆宝くじ抽選 ---
const checkDailyReset = async (roomId) => {
    try {
        const todayStr = getTodayStr();
        if (localLastResetDate === todayStr) return; 
        const { data } = await supabase.from('config').select('value').eq('key', 'last_reset_date').single();
        if (data && data.value === todayStr) { localLastResetDate = todayStr; return; }

        localLastResetDate = todayStr;
        // スロット回数と職業の行動フラグをリセット
        await supabase.from('players').update({ slot_count: 0, work_date: null, skill_date: null }).neq('account_id', '0');
        await supabase.from('config').upsert({ key: 'last_reset_date', value: todayStr });
        
        let resetMsg = `[info][title]🔄 日替わりリセット[/title]深夜0時になりました。\n全プレイヤーの【スロット回数】および【職業の行動制限】がリセットされました！\n\n`;

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
                    if (num % 1000 === win % 1000) return { prize: 10000, name: '2等' }; 
                    if (num % 100 === win % 100) return { prize: 5000, name: '3等' };    
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
                await sendMessage(roomId, `[info]⏳ 1分経過したため、丁半ゲームを開始します！\n参加者は /bet 掛け金 でベットしてください。(1分以内)[/info]`);
                startTimer(roomId, 60000);
            } else {
                await sendMessage(roomId, `[info]参加者が足りないため丁半ゲームを中止します。[/info]`);
                chState[roomId] = { state: 'IDLE', host: null, players: [], timeoutId: null };
            }
        } else if (ch.state === 'BETTING') {
            let kicked = []; let activePlayers = [];
            for (let p of ch.players) {
                if (p.bet === 0) kicked.push(p.aid); else activePlayers.push(p);
            }
            ch.players = activePlayers;
            if (kicked.length > 0) await sendMessage(roomId, `[info]⏳ 未ベットのため以下を退出させました。\n${kicked.map(aid=>`[piconname:${aid}]`).join(' ')}[/info]`);
            
            if (ch.players.length < 2) {
                for (let p of ch.players) {
                    try {
                        const { data } = await supabase.from('players').select('money').eq('account_id', p.aid).single();
                        if (data) await supabase.from('players').update({ money: data.money + p.bet }).eq('account_id', p.aid);
                    } catch(e){}
                }
                await sendMessage(roomId, `[info]参加者が2人未満になったため中止し、全額返金しました。[/info]`);
                chState[roomId] = { state: 'IDLE', host: null, players: [], timeoutId: null };
            } else {
                ch.state = 'CHOOSING';
                await sendMessage(roomId, `[info][title]🎲 丁半 選択[/title]全員のベットが完了！サイコロの合計が【丁(偶数)】か【半(奇数)】かを予想し、 /chou または /han と発言してください。(制限時間1分)[/info]`);
                startTimer(roomId, 60000);
            }
        } else if (ch.state === 'CHOOSING') {
            let kicked = []; let activePlayers = [];
            for (let p of ch.players) {
                if (!p.choice) {
                    kicked.push(p.aid);
                    try {
                        const { data } = await supabase.from('players').select('money').eq('account_id', p.aid).single();
                        if (data) await supabase.from('players').update({ money: data.money + p.bet }).eq('account_id', p.aid);
                    } catch(e){}
                } else activePlayers.push(p);
            }
            ch.players = activePlayers;
            if (kicked.length > 0) await sendMessage(roomId, `[info]⏳ 未選択のため以下を退出・返金しました。\n${kicked.map(aid=>`[piconname:${aid}]`).join(' ')}[/info]`);
            
            if (ch.players.length < 2) {
                for (let p of ch.players) {
                    try {
                        const { data } = await supabase.from('players').select('money').eq('account_id', p.aid).single();
                        if (data) await supabase.from('players').update({ money: data.money + p.bet }).eq('account_id', p.aid);
                    } catch(e){}
                }
                await sendMessage(roomId, `[info]参加者が2人未満になったため中止し、返金しました。[/info]`);
                chState[roomId] = { state: 'IDLE', host: null, players: [], timeoutId: null };
            } else {
                await resolveChouhan(roomId);
            }
        }
    } catch (e) {}
};

const startTimer = (roomId, ms = 60000) => {
    let ch = chState[roomId];
    if (ch.timeoutId) clearTimeout(ch.timeoutId);
    ch.timeoutId = setTimeout(() => { handleTimeout(roomId); }, ms);
};

const resolveChouhan = async (roomId) => {
    try {
        let ch = chState[roomId]; if (!ch) return;
        if (ch.timeoutId) clearTimeout(ch.timeoutId);
        
        let d1 = Math.floor(Math.random() * 6) + 1;
        let d2 = Math.floor(Math.random() * 6) + 1;
        let sum = d1 + d2;
        let resultType = (sum % 2 === 0) ? 'chou' : 'han';
        let resultName = (resultType === 'chou') ? '丁 (偶数)' : '半 (奇数)';

        let msg = `[info][title]🎲 結果発表[/title]サイコロの目は【 ${d1} 】と【 ${d2} 】\n合計： ${sum} ➡ 『 ${resultName} 』！\n\n【プレイヤー結果】\n`;

        for (let p of ch.players) {
            let isWin = (p.choice === resultType);
            let winAmount = isWin ? p.bet * 2 : 0;
            let choiceName = (p.choice === 'chou') ? '丁' : '半';
            
            if (isWin) {
                msg += `[piconname:${p.aid}]: 予想「${choiceName}」 ➡ 当たり！ 🎉 (+${winAmount} コイン)\n`;
                try {
                    const { data } = await supabase.from('players').select('money').eq('account_id', p.aid).single();
                    if (data) await supabase.from('players').update({ money: data.money + winAmount }).eq('account_id', p.aid);
                } catch(e){}
            } else {
                msg += `[piconname:${p.aid}]: 予想「${choiceName}」 ➡ はずれ\n`;
            }
        }
        msg += `[/info]`;
        await sendMessage(roomId, msg);
        chState[roomId] = { state: 'IDLE', host: null, players: [], timeoutId: null };
    } catch (e) {}
};


// --- Webhook メイン処理 ---
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid Signature');

    const eventType = req.body.webhook_event_type;
    const event = req.body.webhook_event;
    if (!event || eventType !== 'message_created') return res.status(200).send('Ignored');

    res.status(200).send('OK'); 

    const roomId = event.room_id;
    const body = event.body || "";
    const senderId = event.account_id.toString();
    const messageId = event.message_id;
    const today = getTodayStr();

    (async () => {
        try {
            // ★【完全修正】返信タグの取得（どんなフォーマットでもAIDを抜く）
            const globalReplyMatch = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const repliedAid = globalReplyMatch ? globalReplyMatch[1] : null;

            // --- ブラックリスト防衛 ---
            const { data: isBlacklisted } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId);
            if (isBlacklisted && isBlacklisted.length > 0) {
                await updateRoomMembers(roomId, [senderId], 'kick'); 
                await deleteMessage(roomId, messageId); 
                return;
            }
            runPatrol(roomId);
            checkDailyReset(roomId);

            // --- スパム（連投）検知 ---
            if (checkSpam(senderId)) {
                if (!(await isUserAdmin(roomId, senderId))) {
                    await updateRoomMembers(roomId, [senderId], 'readonly');
                    await sendMessage(roomId, `[info]⚠️ [piconname:${senderId}] 5秒間に10回の連投を検知したため、権限を「閲覧のみ」に制限しました。[/info]`);
                    return;
                }
            }

            // --- コマンド一覧 (/help-gya) ---
            if (body.trim() === '/help-gya') {
                const helpMsg = `[info][title]🎰 ギャンブル機能 コマンド一覧[/title]
[b]【 基本コマンド 】[/b]
/status : 自分の所持金・職業・スロット残り回数を確認
/give [金額] : 返信で相手を指定してコインを送金
/money-rank : 所持金ランキングTOP10を表示 (5分で消去)

[b]【 職業・仕事 】[/b]
/job : 職業一覧と給料を表示
/job [職業名] : 指定の職業に就職
/work : 職業に応じた給料を獲得 (1日1回)
/catch : 警察官の特殊能力 (1日1回)
/goal : スポーツ選手の特殊能力 (1日1回)

[b]【 ゲーム 】[/b]
/slot [掛け金] : スロットを回す (1日3回まで)
/buy-lot [数字] : 宝くじ購入 (深夜0時抽選、同じ数字は不可)

[b]【 🎲 丁半ゲーム 】[/b]
/chouhan : 募集開始
/join chouhan : 参加
/bet [掛け金] : ベット
/chou または /han : 丁・半を予想
/leave : ゲームから退出 (返金あり)

[b]【 管理者専用 】[/b]
/st-gya : ギャンブル有効化
/fi-gya : ギャンブル無効化
/remove-rank : 返信で相手をランキングから除外・解除
[/info]`;
                await sendTempMessage(roomId, helpMsg, 120000); 
                return;
            }

            // --- ランキング除外コマンド ---
            if (/(^|\n)\/remove-rank/.test(body)) {
                if (!(await isUserAdmin(roomId, senderId))) return;
                let targetAid = repliedAid; 
                if (!targetAid) {
                    const match = body.match(/(^|\n)\/remove-rank\s+([0-9]+)/);
                    if (match) targetAid = match[2];
                }
                if (!targetAid) return;
                
                const { data: excData } = await supabase.from('config').select('value').eq('key', 'rank_excluded').single();
                let excluded = excData ? JSON.parse(excData.value) : [];
                
                if (excluded.includes(targetAid)) {
                    excluded = excluded.filter(id => id !== targetAid);
                    await sendTempMessage(roomId, `[info][piconname:${targetAid}] をランキング除外から【解除】しました。[/info]`);
                } else {
                    excluded.push(targetAid);
                    await sendTempMessage(roomId, `[info][piconname:${targetAid}] をランキングから【除外】しました。[/info]`);
                }
                await supabase.from('config').upsert({ key: 'rank_excluded', value: JSON.stringify(excluded) });
                return;
            }

            // --- ブラックリスト コマンド ---
            const isBlacklistCmd = /(^|\n)\/blacklist(\s|$)/.test(body);
            const isReblacklistCmd = /(^|\n)\/reblacklist(\s|$)/.test(body);

            if (isBlacklistCmd || isReblacklistCmd) {
                if (!(await isUserAdmin(roomId, senderId))) return;

                let targetAid = repliedAid; 
                let commandType = isBlacklistCmd ? 'add' : 'remove';

                if (!targetAid) {
                    const cmdMatch = body.match(/(^|\n)\/(?:blacklist|reblacklist)\s+([0-9]+)/);
                    if (cmdMatch) { targetAid = cmdMatch[2]; } 
                    else if (isReblacklistCmd) return;
                    else commandType = 'list';
                }

                if (commandType === 'add' && targetAid) {
                    const { data: existing } = await supabase.from('blacklist').select('account_id').eq('account_id', targetAid);
                    if (existing && existing.length > 0) {
                        await sendTempMessage(roomId, `[info][piconname:${targetAid}] は【既に】ブラックリストに登録されています。[/info]`);
                    } else {
                        await supabase.from('blacklist').insert({ account_id: targetAid });
                        await updateRoomMembers(roomId, [targetAid], 'kick');
                        await sendTempMessage(roomId, `[info][piconname:${targetAid}] をブラックリストに新規登録し、強制追放しました。[/info]`);
                    }
                } 
                else if (commandType === 'remove' && targetAid) {
                    await supabase.from('blacklist').delete().eq('account_id', targetAid);
                    await sendTempMessage(roomId, `[info][piconname:${targetAid}] をブラックリストから解除しました。[/info]`);
                } 
                else if (commandType === 'list') {
                    const { data } = await supabase.from('blacklist').select('account_id');
                    const listStr = data && data.length > 0 ? data.map(d => `[piconname:${d.account_id}] (ID: ${d.account_id})`).join('\n') : "登録なし";
                    await sendTempMessage(roomId, `[info][title]ブラックリスト一覧[/title]${listStr}\n\n※1分後に自動消去されます[/info]`);
                }
                return;
            }

            // --- ギャンブル全般管理 ---
            if (body.startsWith('/st-gya')) {
                if (!(await isUserAdmin(roomId, senderId))) return;
                gambleActive = true;
                await supabase.from('config').upsert({ key: 'gamble_active', value: 'true' });
                await sendMessage(roomId, `[info][title]🎰 ギャンブル開始[/title]ギャンブル機能が有効になりました！\n発言ごとに1コイン獲得できます。[/info]`);
                return;
            }
            if (body.startsWith('/fi-gya')) {
                if (!(await isUserAdmin(roomId, senderId))) return;
                gambleActive = false;
                await supabase.from('config').upsert({ key: 'gamble_active', value: 'false' });
                await sendMessage(roomId, `[info]ギャンブル機能が無効になりました。[/info]`);
                return;
            }

            // --- プレイヤーデータ取得 ---
            const { data: pData } = await supabase.from('players').select('*').eq('account_id', senderId).single();
            let myMoney = pData ? pData.money : 0;
            let myJob = pData ? (pData.job || 'サラリーマン') : 'サラリーマン';

            // --- 送金コマンド (/give) ---
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
                if (myMoney < amount) return await sendTempMessage(roomId, `[rp aid=${senderId}] 持ち金が足りません！`);
                
                const { data: receiver } = await supabase.from('players').select('*').eq('account_id', targetAid).single();
                await supabase.from('players').update({ money: myMoney - amount }).eq('account_id', senderId);
                if (receiver) await supabase.from('players').update({ money: receiver.money + amount }).eq('account_id', targetAid);
                else await supabase.from('players').insert({ account_id: targetAid, money: amount, debt: 0, slot_count: 0 });
                
                await sendTempMessage(roomId, `[info][piconname:${senderId}] ➡ [piconname:${targetAid}]\n${amount} コインを送金しました。[/info]`);
                return;
            }

            // --- 職業機能 (/job, /work, /catch, /goal) ---
            if (/(^|\n)\/job(\s|$)/.test(body) && gambleActive) {
                const jobMsg = `[info][title]💼 ハローワーク[/title]
👨‍💼 サラリーマン (就職: 0コイン)
・ /work (100〜500) ※10%でミス0コイン

🏛️ 公務員 (就職: 2000コイン)
・ /work (300〜500)

🚓 警察官 (就職: 3000コイン)
・ /work (300〜700)
・ /catch (30%で逮捕! 800)

⚽ プロスポーツ選手 (就職: 5000コイン)
・ /work (500〜1000)
・ /goal (30%でゴール! 1000)

※就職は /job 役職名
※各コマンド1日1回[/info]`;
                return await sendTempMessage(roomId, jobMsg, 60000);
            }

            const changeJobMatch = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (changeJobMatch && gambleActive) {
                const jobName = changeJobMatch[2];
                const prices = { 'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000 };
                const price = prices[jobName];
                
                if (myJob === jobName) return await sendTempMessage(roomId, `[rp aid=${senderId}] すでに${jobName}です！`);
                if (myMoney < price) return await sendTempMessage(roomId, `[rp aid=${senderId}] お金が足りません！就職には ${price} コイン必要です。`);
                
                await supabase.from('players').upsert({ account_id: senderId, money: myMoney - price, job: jobName });
                return await sendTempMessage(roomId, `[info][piconname:${senderId}] ${jobName} に転職しました！🎉 (-${price} コイン)[/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive) {
                if (!pData) return;
                if (pData.work_date === today) return await sendTempMessage(roomId, `[rp aid=${senderId}] 今日の仕事は終了済みです。また明日！`);

                let earned = 0; let msg = "";
                if (myJob === 'サラリーマン') {
                    if (Math.random() < 0.1) { earned = 0; msg = "ケアレスミスをしてしまい、給料は 0 コインになりました...😭"; } 
                    else { earned = Math.floor(Math.random() * 401) + 100; msg = `真面目に働き、 ${earned} コイン稼ぎました！💼`; }
                } else if (myJob === '公務員') { earned = Math.floor(Math.random() * 201) + 300; msg = `安定した仕事をこなし、 ${earned} コイン稼ぎました！🏛️`;
                } else if (myJob === '警察官') { earned = Math.floor(Math.random() * 401) + 300; msg = `街の平和を守り、 ${earned} コイン稼ぎました！🚓`;
                } else if (myJob === 'プロスポーツ選手') { earned = Math.floor(Math.random() * 501) + 500; msg = `試合で活躍し、 ${earned} コイン稼ぎました！⚽`; }

                await supabase.from('players').update({ money: myMoney + earned, work_date: today }).eq('account_id', senderId);
                return await sendTempMessage(roomId, `[info][piconname:${senderId}]\n${msg}[/info]`);
            }

            if (/(^|\n)\/(catch|goal)\b/.test(body) && gambleActive) {
                if (!pData) return;
                let isCatch = /(^|\n)\/catch\b/.test(body);
                if (isCatch && myJob !== '警察官') return await sendTempMessage(roomId, `[rp aid=${senderId}] /catch は警察官専用の能力です！`);
                if (!isCatch && myJob !== 'プロスポーツ選手') return await sendTempMessage(roomId, `[rp aid=${senderId}] /goal はプロスポーツ選手専用の能力です！`);
                if (pData.skill_date === today) return await sendTempMessage(roomId, `[rp aid=${senderId}] 今日の特殊能力はすでに使っています！`);

                let success = Math.random() < 0.3; // 30%
                let earned = 0; let msg = "";
                if (isCatch) {
                    if (success) { earned = 800; msg = `見事犯人を捕まえ、特別報酬 ${earned} コインを獲得！🚨`; }
                    else { msg = `犯人を逃してしまいました...報酬なしです。🏃‍♂️💨`; }
                } else {
                    if (success) { earned = 1000; msg = `スーパーゴールを決め、スポンサーから ${earned} コインを獲得！🥅✨`; }
                    else { msg = `シュートは外れてしまいました...報酬なしです。🤦‍♂️`; }
                }
                await supabase.from('players').update({ money: myMoney + earned, skill_date: today }).eq('account_id', senderId);
                return await sendTempMessage(roomId, `[info][piconname:${senderId}]\n${msg}[/info]`);
            }

            // --- 宝くじ購入 (/buy-lot 1234) ---
            const lotMatch = body.match(/(^|\n)\/buy-lot\s+([0-9]+)/);
            if (gambleActive && lotMatch) {
                const num = parseInt(lotMatch[2], 10);
                if (num >= 1 && num <= 9999) {
                    const { data: lotData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tickets = lotData ? JSON.parse(lotData.value) : [];

                    if (tickets.some(t => t.num === num)) return await sendTempMessage(roomId, `[rp aid=${senderId}] 番号【 ${num} 】は既に買われています！別の番号を選んでください。`);
                    if (myMoney < 100) return await sendTempMessage(roomId, `[rp aid=${senderId}] お金が足りません！宝くじは1枚100コインです。`);
                    
                    await supabase.from('players').update({ money: myMoney - 100 }).eq('account_id', senderId);
                    tickets.push({ aid: senderId, num: num });
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tickets) });
                    await sendTempMessage(roomId, `[info][piconname:${senderId}] 宝くじ【 ${num} 】を100コインで購入しました！\n(抽選は深夜0時)[/info]`);
                } else {
                    await sendTempMessage(roomId, `[rp aid=${senderId}] 宝くじの番号は 1 〜 9999 の間で指定してください！`);
                }
                return;
            }

            // --- ランキング・ステータス ---
            if (body.trim() === '/money-rank') {
                const { data: excData } = await supabase.from('config').select('value').eq('key', 'rank_excluded').single();
                let excluded = excData ? JSON.parse(excData.value) : [];
                const { data } = await supabase.from('players').select('*').order('money', { ascending: false });
                const filtered = data ? data.filter(d => !excluded.includes(d.account_id)).slice(0, 10) : [];
                const listStr = filtered.length > 0 ? filtered.map((d, i) => `${i+1}位: [piconname:${d.account_id}] - ${d.money} コイン`).join('\n') : "データなし";
                
                // ★ランキングは5分(300,000ms)で消去
                await sendTempMessage(roomId, `[info][title]💰 所持金ランキング TOP10[/title]${listStr}\n\n※このメッセージは5分後に自動消去されます[/info]`, 300000);
                return;
            }

            if (body.trim() === '/status') {
                if (pData) {
                    const remainSlot = Math.max(0, 3 - pData.slot_count);
                    await sendTempMessage(roomId, `[info][title]📊 ステータス[/title][piconname:${senderId}] さんの情報\n💰 所持金: ${pData.money} コイン\n👔 職業: ${myJob}\n🎰 本日のスロット残り: ${remainSlot} 回\n\n※1分後に自動消去されます[/info]`);
                } else {
                    await sendTempMessage(roomId, `[info][title]📊 ステータス[/title][piconname:${senderId}] さんのデータはまだありません。\n\n※1分後に自動消去されます[/info]`);
                }
                return;
            }

            // --- スロット (/slot 100) ---
            const slotMatch = body.match(/(^|\n)\/slot\s+([0-9]+)/);
            if (gambleActive && slotMatch) {
                const betAmount = parseInt(slotMatch[2], 10);
                if (betAmount > 0) {
                    if (myMoney < betAmount) return await sendTempMessage(roomId, `[rp aid=${senderId}] お金が足りません！ (所持: ${myMoney}コイン)`);
                    if (pData.slot_count >= 3) return await sendTempMessage(roomId, `[rp aid=${senderId}] 制限到達！スロットは1日一人3回までです。（深夜0時リセット）`);
                    
                    let newMoney = myMoney - betAmount;
                    let newCount = pData.slot_count + 1;
                    const rand = Math.floor(Math.random() * 100);
                    let multiplier = 0, symbolResult = "", msgResult = "";
                    
                    // ★ スロットの確率と役を完全実装
                    if (rand === 0) { multiplier = 100; symbolResult = "🐉 | 🐉 | 🐉"; msgResult = "超大当たり！！！ (100倍)"; } 
                    else if (rand <= 3) { multiplier = 10; symbolResult = "7️⃣ | 7️⃣ | 7️⃣"; msgResult = "大当たり！ (10倍)"; } 
                    else if (rand <= 9) { multiplier = 3; const sym = ["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; symbolResult = `${sym} | ${sym} | ${sym}`; msgResult = "当たり！ (3倍)"; } 
                    else if (rand <= 19) { multiplier = 2; const sym = ["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; symbolResult = `${sym} | ${sym} | ${sym}`; msgResult = "当たり！ (2倍)"; } 
                    else if (rand <= 29) { multiplier = 2; const sym = ["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; symbolResult = `${sym} | ${sym} | ${sym}`; msgResult = "フルーツ揃い！当たり！ (2倍)"; } 
                    else if (rand <= 49) { multiplier = 2; const others = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; const resSyms = ["🍒", others[Math.floor(Math.random()*others.length)], others[Math.floor(Math.random()*others.length)]]; resSyms.sort(() => Math.random() - 0.5); symbolResult = resSyms.join(" | "); msgResult = "チェリー出現！ (2倍)"; } 
                    else { multiplier = 0; const others = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1 = others[Math.floor(Math.random()*others.length)], r2 = others[Math.floor(Math.random()*others.length)], r3 = others[Math.floor(Math.random()*others.length)]; while (r1 === r2 && r2 === r3) r3 = others[Math.floor(Math.random()*others.length)]; symbolResult = `${r1} | ${r2} | ${r3}`; msgResult = "はずれ！"; }
                    
                    const winAmount = betAmount * multiplier;
                    newMoney += winAmount;
                    
                    await supabase.from('players').update({ money: newMoney, slot_count: newCount }).eq('account_id', senderId);
                    await sendMessage(roomId, `[rp aid=${senderId}]\n🎰 スロット結果 🎰\n【 ${symbolResult} 】\n${msgResult}\n賭け金: ${betAmount} ➡ 獲得: ${winAmount} コイン\n(残り回数: ${3 - newCount}回)`);
                }
                return; 
            }

            // --- 丁半ゲーム ---
            if (!chState[roomId]) chState[roomId] = { state: 'IDLE', host: null, players: [], timeoutId: null };
            let ch = chState[roomId];

            if (body.trim() === '/chouhan' && gambleActive) {
                if (ch.state !== 'IDLE') return;
                ch.state = 'RECRUITING';
                ch.host = senderId;
                ch.players = [{ aid: senderId, bet: 0, choice: null }];
                await sendMessage(roomId, `[info][title]🎲 丁半ゲーム募集開始[/title]丁半ゲームを開始しました！\n参加者は /join chouhan と入力してください。(現在 1人)\nホスト([piconname:${senderId}])は /startchouhan で強制開始できます。\n※1分経過で自動開始します。[/info]`);
                startTimer(roomId, 60000);
                return;
            }

            if (body.trim() === '/join chouhan' && gambleActive) {
                if (ch.state !== 'RECRUITING') return;
                if (ch.players.find(p => p.aid === senderId)) return;
                ch.players.push({ aid: senderId, bet: 0, choice: null });
                
                await sendMessage(roomId, `[info][piconname:${senderId}] が丁半に参加しました！ (現在 ${ch.players.length}人)[/info]`);
                return;
            }

            if (body.trim() === '/startchouhan' && gambleActive) {
                if (ch.state !== 'RECRUITING' || ch.host !== senderId) return;
                if (ch.players.length < 2) {
                    await sendTempMessage(roomId, `[info]丁半ゲームは2人以上でないと開始できません。[/info]`);
                    return;
                }
                ch.state = 'BETTING';
                await sendMessage(roomId, `[info][title]ベット受付開始[/title]ホストが強制開始しました！\n参加者は /bet 掛け金 でベットしてください。(1分以内)[/info]`);
                startTimer(roomId, 60000);
                return;
            }

            if (body.trim() === '/leave' && gambleActive) {
                if (ch.state !== 'IDLE') {
                    let pIndex = ch.players.findIndex(p => p.aid === senderId);
                    if (pIndex !== -1) {
                        let p = ch.players[pIndex];
                        ch.players.splice(pIndex, 1);
                        if (p.bet > 0) {
                            await supabase.from('players').update({ money: myMoney + p.bet }).eq('account_id', p.aid);
                        }
                        await sendMessage(roomId, `[info][piconname:${senderId}] が丁半ゲームから退出しました。${p.bet > 0 ? '(掛け金は返還されました)' : ''}[/info]`);
                        
                        if (ch.players.length === 0) {
                            if (ch.timeoutId) clearTimeout(ch.timeoutId);
                            ch.state = 'IDLE';
                            return await sendMessage(roomId, `[info]参加者がいなくなったため、丁半ゲームを中止します。[/info]`);
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
                if (myMoney < betAmount) return await sendTempMessage(roomId, `[rp aid=${senderId}] お金が足りません！`);
                
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

        } catch (error) {
            console.error(error);
        }
    })();
});

// Vercel用のExport
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;
