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

const verifySignature = (req) => {
    const signature = req.headers['x-chatworkwebhooksignature'];
    if (!signature) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return signature === expected;
};

const sendMessage = (roomId, text) => cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`).catch(()=>{});
const deleteMessage = (roomId, messageId) => cw.delete(`/rooms/${roomId}/messages/${messageId}`).catch(()=>{});

// --- 丁半ゲーム タイムアウト＆進行処理（安全装置追加） ---
const handleTimeout = async (roomId) => {
    try {
        let ch = chState[roomId];
        if (!ch || ch.state === 'IDLE') return;

        if (ch.state === 'RECRUITING') {
            if (ch.players.length > 0) {
                ch.state = 'BETTING';
                await sendMessage(roomId, `[info]⏳ 1分経過したため募集を締め切り、丁半ゲームを開始します！\n参加者は /bet 掛け金 でベットしてください。(1分以内にベットがないと退出になります)[/info]`);
                startTimer(roomId, 60000);
            } else {
                ch.state = 'IDLE';
            }
        } else if (ch.state === 'BETTING') {
            let kicked = [];
            let activePlayers = [];
            for (let p of ch.players) {
                if (p.bet === 0) kicked.push(p.aid);
                else activePlayers.push(p);
            }
            ch.players = activePlayers;
            if (kicked.length > 0) {
                await sendMessage(roomId, `[info]⏳ ベット制限時間(1分)を超過したため、以下のプレイヤーを退出させました。\n${kicked.map(aid=>`[piconname:${aid}]`).join(' ')}[/info]`);
            }
            if (ch.players.length === 0) {
                await sendMessage(roomId, `[info]参加者がいなくなったため、丁半ゲームを中止します。[/info]`);
                ch.state = 'IDLE';
            } else {
                await moveToChoosing(roomId);
            }
        } else if (ch.state === 'CHOOSING') {
            let kicked = [];
            let activePlayers = [];
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
            if (kicked.length > 0) {
                await sendMessage(roomId, `[info]⏳ 選択制限時間(1分)を超過したため、以下のプレイヤーを退出させ返金しました。\n${kicked.map(aid=>`[piconname:${aid}]`).join(' ')}[/info]`);
            }
            if (ch.players.length === 0) {
                await sendMessage(roomId, `[info]参加者がいなくなったため、丁半ゲームを中止します。[/info]`);
                ch.state = 'IDLE';
            } else {
                await resolveChouhan(roomId);
            }
        }
    } catch (e) {
        console.error("Timeout Error:", e);
    }
};

const startTimer = (roomId, ms = 60000) => {
    let ch = chState[roomId];
    if (ch.timeoutId) clearTimeout(ch.timeoutId);
    ch.timeoutId = setTimeout(() => { handleTimeout(roomId); }, ms);
};

const moveToChoosing = async (roomId) => {
    try {
        let ch = chState[roomId];
        if (!ch) return;
        ch.state = 'CHOOSING';
        await sendMessage(roomId, `[info][title]🎲 丁半 選択[/title]全員のベットが完了しました！\nサイコロの合計が【丁(偶数)】か【半(奇数)】かを予想してください。\n\n/chou または /han と発言してください。(制限時間1分)[/info]`);
        startTimer(roomId, 60000);
    } catch (e) { console.error("Choosing Error:", e); }
};

const resolveChouhan = async (roomId) => {
    try {
        let ch = chState[roomId];
        if (!ch) return;
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
    } catch (e) { console.error("Resolve Error:", e); }
};

// --- 防衛・連投機能 ---
const checkSpam = (accountId) => {
    const now = Date.now();
    if (!spamRecords[accountId]) spamRecords[accountId] = [];
    spamRecords[accountId].push(now);
    spamRecords[accountId] = spamRecords[accountId].filter(t => now - t <= 5000);
    if (spamRecords[accountId].length >= 10) {
        spamRecords[accountId] = [];
        return true;
    }
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

const checkDailyReset = async (roomId) => {
    try {
        const now = new Date();
        const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
        const todayStr = jst.toISOString().split('T')[0];
        
        if (localLastResetDate === todayStr) return; 
        const { data } = await supabase.from('config').select('value').eq('key', 'last_reset_date').single();
        if (data && data.value === todayStr) {
            localLastResetDate = todayStr;
            return;
        }

        localLastResetDate = todayStr;
        await supabase.from('players').update({ slot_count: 0 }).neq('account_id', '0');
        await supabase.from('config').upsert({ key: 'last_reset_date', value: todayStr });
        if (roomId) await sendMessage(roomId, `[info][title]🔄 日替わりリセット[/title]深夜0時になりました。\n全プレイヤーの【スロット回数】が 0 にリセットされました！[/info]`);
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

    (async () => {
        try {
            // --- ブラックリスト防衛 ---
            const { data: isBlacklisted } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId);
            if (isBlacklisted && isBlacklisted.length > 0) {
                await updateRoomMembers(roomId, [senderId], 'kick'); 
                await deleteMessage(roomId, messageId); 
                return;
            }
            runPatrol(roomId);

            // --- スパム（連投）検知 ---
            if (checkSpam(senderId)) {
                const isAdmin = await isUserAdmin(roomId, senderId);
                if (!isAdmin) {
                    await updateRoomMembers(roomId, [senderId], 'readonly');
                    await sendMessage(roomId, `[info]⚠️ [piconname:${senderId}] 5秒間に10回の連投を検知したため、権限を「閲覧のみ」に制限しました。[/info]`);
                    return;
                }
            }

            // --- コマンド判定 ---
            const isBlacklistCmd = /(^|\n)\/blacklist(\s|$)/.test(body);
            const isReblacklistCmd = /(^|\n)\/reblacklist(\s|$)/.test(body);

            if (isBlacklistCmd || isReblacklistCmd) {
                const isAdmin = await isUserAdmin(roomId, senderId);
                if (!isAdmin) return;

                let targetAid = null;
                let commandType = 'list';
                const replyMatch = body.match(/\[(?:rp|qtmeta)\s+aid=([0-9]+)/);
                if (replyMatch) {
                    targetAid = replyMatch[1]; commandType = isBlacklistCmd ? 'add' : 'remove';
                } else {
                    const cmdMatch = body.match(/\/(?:blacklist|reblacklist)\s+([0-9]+)/);
                    if (cmdMatch) { targetAid = cmdMatch[1]; commandType = isBlacklistCmd ? 'add' : 'remove'; } 
                    else if (isReblacklistCmd) return;
                }

                if (commandType === 'add' && targetAid) {
                    const { data: existing } = await supabase.from('blacklist').select('account_id').eq('account_id', targetAid);
                    if (existing && existing.length > 0) {
                        await sendMessage(roomId, `[info][piconname:${targetAid}] は【既に】ブラックリストに登録されています。[/info]`);
                    } else {
                        await supabase.from('blacklist').insert({ account_id: targetAid });
                        await updateRoomMembers(roomId, [targetAid], 'kick');
                        await sendMessage(roomId, `[info][piconname:${targetAid}] をブラックリストに新規登録し、強制追放しました。[/info]`);
                    }
                } 
                else if (commandType === 'remove' && targetAid) {
                    await supabase.from('blacklist').delete().eq('account_id', targetAid);
                    await sendMessage(roomId, `[info][piconname:${targetAid}] をブラックリストから解除しました。[/info]`);
                } 
                else if (commandType === 'list') {
                    const { data } = await supabase.from('blacklist').select('account_id');
                    const listStr = data && data.length > 0 ? data.map(d => `[piconname:${d.account_id}] (ID: ${d.account_id})`).join('\n') : "登録なし";
                    const resMsg = await sendMessage(roomId, `[info][title]ブラックリスト一覧[/title]${listStr}\n\n※1分後に自動消去されます[/info]`);
                    if (resMsg && resMsg.data) setTimeout(() => deleteMessage(roomId, resMsg.data.message_id), 60000);
                }
                return;
            }

            // --- ギャンブル全般 ---
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

            if (body.startsWith('/give ')) {
                const parts = body.split(/\s+/);
                const targetAid = parts[1];
                const amount = parseInt(parts[2], 10);
                if (!targetAid || isNaN(amount) || amount <= 0) return;
                const { data: sender } = await supabase.from('players').select('*').eq('account_id', senderId).single();
                if (!sender || sender.money < amount) return await sendMessage(roomId, `[rp aid=${senderId}] 持ち金が足りません！`);
                
                const { data: receiver } = await supabase.from('players').select('*').eq('account_id', targetAid).single();
                await supabase.from('players').update({ money: sender.money - amount }).eq('account_id', senderId);
                if (receiver) await supabase.from('players').update({ money: receiver.money + amount }).eq('account_id', targetAid);
                else await supabase.from('players').insert({ account_id: targetAid, money: amount, debt: 0, slot_count: 0 });
                await sendMessage(roomId, `[info][piconname:${senderId}] ➡ [piconname:${targetAid}]\n${amount} コインを送金しました。[/info]`);
                return;
            }

            if (body.trim() === '/money-rank') {
                const { data } = await supabase.from('players').select('*').order('money', { ascending: false }).limit(10);
                const listStr = data && data.length > 0 
                    ? data.map((d, i) => `${i+1}位: [piconname:${d.account_id}] - ${d.money} コイン`).join('\n') : "データなし";
                const resMsg = await sendMessage(roomId, `[info][title]💰 所持金ランキング TOP10[/title]${listStr}\n\n※このメッセージは5分後に消去されます[/info]`);
                if (resMsg && resMsg.data) setTimeout(() => deleteMessage(roomId, resMsg.data.message_id), 300000);
                return;
            }

            // --- スロット (/slot 100) ---
            const slotMatch = body.match(/(^|\n)\/slot\s+([0-9]+)/);
            if (gambleActive && slotMatch) {
                const betAmount = parseInt(slotMatch[2], 10);
                if (betAmount > 0) {
                    const { data } = await supabase.from('players').select('*').eq('account_id', senderId).single();
                    if (!data || data.money < betAmount) return await sendMessage(roomId, `[rp aid=${senderId}] お金が足りません！ (所持: ${data ? data.money : 0}コイン)`);
                    if (data.slot_count >= 3) return await sendMessage(roomId, `[rp aid=${senderId}] 制限到達！スロットは1日一人3回までです。（深夜0時リセット）`);
                    
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
                await sendMessage(roomId, `[info][title]🎲 丁半ゲーム募集開始[/title]丁半ゲームを開始しました！\n参加者は /join chouhan と入力してください。(現在 1/4人)\nホスト([piconname:${senderId}])は /startchouhan で強制開始できます。\n※1分経過で自動開始します。[/info]`);
                startTimer(roomId, 60000);
                return;
            }

            if (body.trim() === '/join chouhan' && gambleActive) {
                if (ch.state !== 'RECRUITING') return;
                if (ch.players.find(p => p.aid === senderId)) return;
                ch.players.push({ aid: senderId, bet: 0, choice: null });
                
                let msg = `[info][piconname:${senderId}] が丁半に参加しました！ (現在 ${ch.players.length}/4人)[/info]`;
                if (ch.players.length >= 4) {
                    ch.state = 'BETTING';
                    msg += `\n[info][title]ベット受付開始[/title]4人集まりました！\n参加者は /bet 掛け金 でベットしてください。(1分以内)[/info]`;
                    await sendMessage(roomId, msg);
                    startTimer(roomId, 60000);
                } else {
                    await sendMessage(roomId, msg);
                }
                return;
            }

            if (body.trim() === '/startchouhan' && gambleActive) {
                if (ch.state !== 'RECRUITING' || ch.host !== senderId) return;
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
                            const { data } = await supabase.from('players').select('money').eq('account_id', p.aid).single();
                            if (data) await supabase.from('players').update({ money: data.money + p.bet }).eq('account_id', p.aid);
                        }
                        await sendMessage(roomId, `[info][piconname:${senderId}] が丁半ゲームから退出しました。${p.bet > 0 ? '(掛け金は返還されました)' : ''}[/info]`);
                        
                        if (ch.players.length === 0) {
                            if (ch.timeoutId) clearTimeout(ch.timeoutId);
                            ch.state = 'IDLE';
                            await sendMessage(roomId, `[info]参加者がいなくなったため、丁半ゲームを中止します。[/info]`);
                            return;
                        }

                        if (ch.state === 'BETTING' && ch.players.every(pl => pl.bet > 0)) {
                            await moveToChoosing(roomId);
                        } else if (ch.state === 'CHOOSING' && ch.players.every(pl => pl.choice)) {
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
                
                const { data } = await supabase.from('players').select('money').eq('account_id', senderId).single();
                if (!data || data.money < betAmount) return await sendMessage(roomId, `[rp aid=${senderId}] お金が足りません！`);
                
                await supabase.from('players').update({ money: data.money - betAmount }).eq('account_id', senderId);
                p.bet = betAmount;
                await sendMessage(roomId, `[info][piconname:${senderId}] が ${betAmount} コインをベットしました！[/info]`);
                
                if (ch.players.every(pl => pl.bet > 0)) {
                    await moveToChoosing(roomId);
                }
                return;
            }

            if ((body.trim() === '/chou' || body.trim() === '/han') && gambleActive) {
                if (ch.state !== 'CHOOSING') return;
                let p = ch.players.find(p => p.aid === senderId);
                if (!p || p.choice) return;
                
                p.choice = body.trim() === '/chou' ? 'chou' : 'han';
                let choiceName = p.choice === 'chou' ? '丁' : '半';
                await sendMessage(roomId, `[info][piconname:${senderId}] が「${choiceName}」を選択しました！[/info]`);
                
                if (ch.players.every(pl => pl.choice)) {
                    await resolveChouhan(roomId);
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

// --- ループ処理 ---
setInterval(() => {
    if (TARGET_ROOM_ID) {
        runPatrol(TARGET_ROOM_ID);
        checkDailyReset(TARGET_ROOM_ID);
    }
}, 10000);

app.get('/', (req, res) => res.send('Bot is Live - V17 (Stable)'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));
