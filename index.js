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

const getTodayStr = () => {
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().split('T')[0];
};

const initBot = async () => {
    try {
        const { data } = await supabase.from('config').select('value').eq('key', 'gamble_active').single();
        if (data) gambleActive = data.value === 'true';
    } catch (e) {}
};
initBot();

const verifySignature = (req) => {
    const signature = req.headers['x-chatworkwebhooksignature'];
    if (!signature) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return signature === expected;
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

// --- 防衛・連投機能 ---
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
        await supabase.from('players').update({ slot_count: 0 }).neq('account_id', '0');
        await supabase.from('config').upsert({ key: 'last_reset_date', value: todayStr });
        
        let resetMsg = `[info][title]🔄 日替わりリセット[/title]深夜0時になりました。\n全プレイヤーの【スロット回数】が 0 にリセットされました！\n\n`;

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
            const globalReplyMatch = body.match(/\[[^\]]*?aid=([0-9]+)/i);
            const repliedAid = globalReplyMatch ? globalReplyMatch[1] : null;

            // --- ブラックリスト防衛 ---
            const { data: isBlacklisted } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId);
            if (isBlacklisted && isBlacklisted.length > 0) {
                await updateRoomMembers(roomId, [senderId], 'kick'); 
                await deleteMessage(roomId, messageId); 
                return;
            }
            runPatrol(roomId);

            if (checkSpam(senderId)) {
                if (!(await isUserAdmin(roomId, senderId))) {
                    await updateRoomMembers(roomId, [senderId], 'readonly');
                    await sendMessage(roomId, `[info]⚠️ [piconname:${senderId}] 連投を検知し「閲覧のみ」に制限しました。[/info]`);
                    return;
                }
            }

            // --- ★新規: 職業・仕事機能 (/job, /work, /catch, /goal) ---
            if (body.match(/\/(job|職業)\b/) && !body.match(/\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/)) {
                const jobMsg = `[info][title]💼 職業センター (ハローワーク)[/title]
【現在の求人一覧】 ※転職は /job 役職名
👨‍💼 サラリーマン (就職: 0コイン)
・ /work (100〜500コイン) ※10%の確率でミスして0コイン

🏛️ 公務員 (就職: 2000コイン)
・ /work (300〜500コイン)

🚓 警察官 (就職: 3000コイン)
・ /work (300〜700コイン)
・ /catch (30%の確率で犯人逮捕! 800コイン)

⚽ プロスポーツ選手 (就職: 5000コイン)
・ /work (500〜1000コイン)
・ /goal (30%の確率でスーパーゴール! 1000コイン)

※ /work と 特殊能力 はそれぞれ1日1回までです。[/info]`;
                return await sendTempMessage(roomId, jobMsg, 60000);
            }

            const changeJobMatch = body.match(/\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (changeJobMatch && gambleActive) {
                const jobName = changeJobMatch[1];
                const prices = { 'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000 };
                const price = prices[jobName];
                
                const { data } = await supabase.from('players').select('*').eq('account_id', senderId).single();
                let money = data ? data.money : 0;
                let currentJob = data ? (data.job || 'サラリーマン') : 'サラリーマン';
                
                if (currentJob === jobName) return await sendTempMessage(roomId, `[rp aid=${senderId}] すでに${jobName}です！`);
                if (money < price) return await sendTempMessage(roomId, `[rp aid=${senderId}] お金が足りません！就職には ${price} コイン必要です。`);
                
                await supabase.from('players').upsert({ account_id: senderId, money: money - price, job: jobName });
                return await sendTempMessage(roomId, `[info][piconname:${senderId}] ${jobName} に就職・転職しました！🎉\n(-${price} コイン)[/info]`);
            }

            if (/\/work\b/.test(body) && gambleActive) {
                const { data } = await supabase.from('players').select('*').eq('account_id', senderId).single();
                if (!data) return;
                let job = data.job || 'サラリーマン';
                if (data.work_date === today) return await sendTempMessage(roomId, `[rp aid=${senderId}] 今日の仕事はすでに終わっています。また明日！`);

                let earned = 0; let msg = "";
                if (job === 'サラリーマン') {
                    if (Math.random() < 0.1) { earned = 0; msg = "ケアレスミスをしてしまい、今日の給料は 0 コインになりました...😭"; } 
                    else { earned = Math.floor(Math.random() * 401) + 100; msg = `真面目に働き、 ${earned} コイン稼ぎました！💼`; }
                } else if (job === '公務員') {
                    earned = Math.floor(Math.random() * 201) + 300; msg = `安定した仕事をこなし、 ${earned} コイン稼ぎました！🏛️`;
                } else if (job === '警察官') {
                    earned = Math.floor(Math.random() * 401) + 300; msg = `街の平和を守り、 ${earned} コイン稼ぎました！🚓`;
                } else if (job === 'プロスポーツ選手') {
                    earned = Math.floor(Math.random() * 501) + 500; msg = `試合で活躍し、 ${earned} コイン稼ぎました！⚽`;
                }

                await supabase.from('players').update({ money: data.money + earned, work_date: today }).eq('account_id', senderId);
                return await sendTempMessage(roomId, `[info][piconname:${senderId}]\n${msg}[/info]`);
            }

            if ((/\/catch\b/.test(body) || /\/goal\b/.test(body)) && gambleActive) {
                const { data } = await supabase.from('players').select('*').eq('account_id', senderId).single();
                if (!data) return;
                let job = data.job || 'サラリーマン';
                let isCatch = /\/catch\b/.test(body);
                if (isCatch && job !== '警察官') return await sendTempMessage(roomId, `[rp aid=${senderId}] /catch は警察官専用の特殊能力です！`);
                if (!isCatch && job !== 'プロスポーツ選手') return await sendTempMessage(roomId, `[rp aid=${senderId}] /goal はプロスポーツ選手専用の特殊能力です！`);
                if (data.skill_date === today) return await sendTempMessage(roomId, `[rp aid=${senderId}] 今日の特殊能力はすでに使っています！`);

                let success = Math.random() < 0.3; // 30%
                let earned = 0; let msg = "";
                if (isCatch) {
                    if (success) { earned = 800; msg = `見事犯人を捕まえ、特別報酬 ${earned} コインを獲得しました！🚨`; }
                    else { msg = `犯人を逃してしまいました...報酬なしです。🏃‍♂️💨`; }
                } else {
                    if (success) { earned = 1000; msg = `スーパーゴールを決め、スポンサーから ${earned} コインを獲得しました！🥅✨`; }
                    else { msg = `シュートは外れてしまいました...報酬なしです。🤦‍♂️`; }
                }
                await supabase.from('players').update({ money: data.money + earned, skill_date: today }).eq('account_id', senderId);
                return await sendTempMessage(roomId, `[info][piconname:${senderId}]\n${msg}[/info]`);
            }


            // --- ランキング除外コマンド ---
            if (/\/remove-rank\b/.test(body)) {
                const isAdmin = await isUserAdmin(roomId, senderId);
                if (!isAdmin) return;
                let targetAid = repliedAid;
                if (!targetAid) {
                    const match = body.match(/\/remove-rank\s+([0-9]+)/);
                    if (match) targetAid = match[1];
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
            if (/(?:blacklist|reblacklist)\b/.test(body)) {
                const isAdmin = await isUserAdmin(roomId, senderId);
                if (!isAdmin) return;
                let targetAid = repliedAid;
                let commandType = /\/blacklist\b/.test(body) ? 'add' : 'remove';
                if (!targetAid) {
                    const cmdMatch = body.match(/\/(?:blacklist|reblacklist)\s+([0-9]+)/);
                    if (cmdMatch) { targetAid = cmdMatch[1]; } else commandType = 'list';
                }

                if (commandType === 'add' && targetAid) {
                    await supabase.from('blacklist').upsert({ account_id: targetAid });
                    await updateRoomMembers(roomId, [targetAid], 'kick');
                    await sendTempMessage(roomId, `[info][piconname:${targetAid}] をブラックリストに新規登録し、強制追放しました。[/info]`);
                } else if (commandType === 'remove' && targetAid) {
                    await supabase.from('blacklist').delete().eq('account_id', targetAid);
                    await sendTempMessage(roomId, `[info][piconname:${targetAid}] をブラックリストから解除しました。[/info]`);
                } else if (commandType === 'list') {
                    const { data } = await supabase.from('blacklist').select('account_id');
                    const listStr = data && data.length > 0 ? data.map(d => `[piconname:${d.account_id}] (ID: ${d.account_id})`).join('\n') : "登録なし";
                    await sendTempMessage(roomId, `[info][title]ブラックリスト一覧[/title]${listStr}\n\n※1分後に自動消去されます[/info]`);
                }
                return;
            }

            // --- ギャンブル・借金関連 ---
            if (/\/st-gya\b/.test(body) && await isUserAdmin(roomId, senderId)) {
                gambleActive = true; await supabase.from('config').upsert({ key: 'gamble_active', value: 'true' });
                return await sendMessage(roomId, `[info][title]🎰 ギャンブル開始[/title]ギャンブル機能が有効になりました！\n発言ごとに1コイン獲得できます。[/info]`);
            }
            if (/\/fi-gya\b/.test(body) && await isUserAdmin(roomId, senderId)) {
                gambleActive = false; await supabase.from('config').upsert({ key: 'gamble_active', value: 'false' });
                return await sendMessage(roomId, `[info]ギャンブル機能が無効になりました。[/info]`);
            }

            // ★借金機能 (/debt 1000)
            const debtMatch = body.match(/\/debt\s+([0-9]+)/);
            if (debtMatch && gambleActive) {
                const amount = parseInt(debtMatch[1], 10);
                const { data } = await supabase.from('players').select('*').eq('account_id', senderId).single();
                let money = data ? data.money : 0;
                let debt = data ? (data.debt || 0) : 0;
                
                await supabase.from('players').upsert({ account_id: senderId, money: money + amount, debt: debt + amount });
                return await sendTempMessage(roomId, `[info][piconname:${senderId}] ${amount} コインを借金しました！💸[/info]`);
            }

            // ★送金機能 (/give)
            if (/\/give\b/.test(body) && gambleActive) {
                let targetAid = repliedAid;
                let amount = 0;

                if (targetAid) {
                    const match = body.match(/\/give\s+([0-9]+)/);
                    if (match) amount = parseInt(match[1], 10);
                } else {
                    const match = body.match(/\/give\s+([0-9]+)\s+([0-9]+)/);
                    if (match) { targetAid = match[1]; amount = parseInt(match[2], 10); }
                }

                if (!targetAid || isNaN(amount) || amount <= 0) return;
                
                const { data: sender } = await supabase.from('players').select('*').eq('account_id', senderId).single();
                let debt = sender ? (sender.debt || 0) : 0;
                let money = sender ? sender.money : 0;
                
                // ★借金制限：所持金から借金を引いた「純資産」以上は送金できない
                let availableMoney = Math.max(0, money - debt);
                if (availableMoney < amount) {
                    return await sendTempMessage(roomId, `[rp aid=${senderId}] 持ち金が足りません！\n(借金があるため、送金可能な純資産は ${availableMoney} コインです)`);
                }
                
                const { data: receiver } = await supabase.from('players').select('*').eq('account_id', targetAid).single();
                await supabase.from('players').update({ money: money - amount }).eq('account_id', senderId);
                if (receiver) await supabase.from('players').update({ money: receiver.money + amount }).eq('account_id', targetAid);
                else await supabase.from('players').insert({ account_id: targetAid, money: amount, debt: 0, slot_count: 0 });
                
                return await sendTempMessage(roomId, `[info][piconname:${senderId}] ➡ [piconname:${targetAid}]\n${amount} コインを送金しました。[/info]`);
            }

            // --- ステータス・ランキング ---
            if (/\/status\b/.test(body)) {
                const { data } = await supabase.from('players').select('*').eq('account_id', senderId).single();
                if (data) {
                    const remainSlot = Math.max(0, 3 - data.slot_count);
                    const jobStr = data.job || 'サラリーマン';
                    const debtStr = (data.debt && data.debt > 0) ? `\n💳 借金: -${data.debt} コイン` : '';
                    await sendTempMessage(roomId, `[info][title]📊 ステータス[/title][piconname:${senderId}] さんの情報\n💰 所持金: ${data.money} コイン${debtStr}\n👔 職業: ${jobStr}\n🎰 本日のスロット残り: ${remainSlot} 回\n\n※1分後に自動消去されます[/info]`);
                } else {
                    await sendTempMessage(roomId, `[info][title]📊 ステータス[/title][piconname:${senderId}] さんのデータはまだありません。\n\n※1分後に自動消去されます[/info]`);
                }
                return;
            }

            if (/\/money-rank\b/.test(body)) {
                const { data: excData } = await supabase.from('config').select('value').eq('key', 'rank_excluded').single();
                let excluded = excData ? JSON.parse(excData.value) : [];

                const { data } = await supabase.from('players').select('*').order('money', { ascending: false });
                const filtered = data ? data.filter(d => !excluded.includes(d.account_id)).slice(0, 10) : [];

                const listStr = filtered.length > 0 
                    ? filtered.map((d, i) => {
                        let debtStr = (d.debt && d.debt > 0) ? ` (借金: -${d.debt})` : '';
                        let jobStr = d.job ? ` [${d.job}]` : ` [サラリーマン]`;
                        return `${i+1}位: [piconname:${d.account_id}] - ${d.money} コイン${debtStr}${jobStr}`;
                    }).join('\n') : "データなし";
                return await sendTempMessage(roomId, `[info][title]💰 所持金ランキング TOP10[/title]${listStr}\n\n※このメッセージは1分後に自動消去されます[/info]`);
            }

            // --- 宝くじ・スロット ---
            const lotMatch = body.match(/\/buy-lot\s+([0-9]+)/);
            if (gambleActive && lotMatch) {
                const num = parseInt(lotMatch[1], 10);
                if (num >= 1 && num <= 9999) {
                    const { data: lotData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tickets = lotData ? JSON.parse(lotData.value) : [];

                    if (tickets.some(t => t.num === num)) return await sendTempMessage(roomId, `[rp aid=${senderId}] 宝くじ番号【 ${num} 】は既に買われています！`);

                    const { data } = await supabase.from('players').select('money').eq('account_id', senderId).single();
                    if (!data || data.money < 100) return await sendTempMessage(roomId, `[rp aid=${senderId}] お金が足りません！宝くじは1枚100コインです。`);
                    
                    await supabase.from('players').update({ money: data.money - 100 }).eq('account_id', senderId);
                    tickets.push({ aid: senderId, num: num });
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tickets) });
                    
                    await sendTempMessage(roomId, `[info][piconname:${senderId}] 宝くじ【 ${num} 】を100コインで購入しました！\n(抽選は深夜0時)[/info]`);
                }
                return;
            }

            const slotMatch = body.match(/\/slot\s+([0-9]+)/);
            if (gambleActive && slotMatch) {
                const betAmount = parseInt(slotMatch[1], 10);
                if (betAmount > 0) {
                    const { data } = await supabase.from('players').select('*').eq('account_id', senderId).single();
                    if (!data || data.money < betAmount) return await sendTempMessage(roomId, `[rp aid=${senderId}] お金が足りません！`);
                    if (data.slot_count >= 3) return await sendTempMessage(roomId, `[rp aid=${senderId}] スロットは1日一人3回までです。（深夜0時リセット）`);
                    
                    let newMoney = data.money - betAmount;
                    let newCount = data.slot_count + 1;
                    const rand = Math.floor(Math.random() * 100);
                    let multiplier = 0, symbolResult = "", msgResult = "";
                    
                    if (rand === 0) { multiplier = 100; symbolResult = "🐉 | 🐉 | 🐉"; msgResult = "超大当たり！！！ (100倍)"; } 
                    else if (rand <= 3) { multiplier = 10; symbolResult = "7️⃣ | 7️⃣ | 7️⃣"; msgResult = "大当たり！ (10倍)"; } 
                    else if (rand <= 9) { multiplier = 3; const sym = ["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; symbolResult = `${sym} | ${sym} | ${sym}`; msgResult = "当たり！ (3倍)"; } 
                    else if (rand <= 19) { multiplier = 2; const sym = ["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; symbolResult = `${sym} | ${sym} | ${sym}`; msgResult = "当たり！ (2倍)"; } 
                    else if (rand <= 29) { multiplier = 2; const sym = ["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; symbolResult = `${sym} | ${sym} | ${sym}`; msgResult = "フルーツ揃い！当たり！ (2倍)"; } 
                    else if (rand <= 49) { multiplier = 2; const others = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; const resSyms = ["🍒", others[Math.floor(Math.random()*others.length)], others[Math.floor(Math.random()*others.length)]]; resSyms.sort(() => Math.random() - 0.5); symbolResult = resSyms.join(" | "); msgResult = "チェリー出現！ (2倍)"; } 
                    else { multiplier = 0; const others = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1 = others[Math.floor(Math.random()*others.length)], r2 = others[Math.floor(Math.random()*others.length)], r3 = others[Math.floor(Math.random()*others.length)]; while (r1 === r2 && r2 === r3) r3 = others[Math.floor(Math.random()*others.length)]; symbolResult = `${r1} | ${r2} | ${r3}`; msgResult = "はずれ！"; }
                    
                    await supabase.from('players').update({ money: newMoney + (betAmount * multiplier), slot_count: newCount }).eq('account_id', senderId);
                    await sendMessage(roomId, `[rp aid=${senderId}]\n🎰 スロット結果 🎰\n【 ${symbolResult} 】\n${msgResult}\n賭け金: ${betAmount} ➡ 獲得: ${betAmount * multiplier} コイン\n(残り回数: ${3 - newCount}回)`);
                }
                return; 
            }

            // --- コイン付与 (コマンド以外の通常発言) ---
            if (gambleActive) {
                const { data: pData } = await supabase.from('players').select('*').eq('account_id', senderId).single();
                if (pData) await supabase.from('players').update({ money: pData.money + 1 }).eq('account_id', senderId);
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
