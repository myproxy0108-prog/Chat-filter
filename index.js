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

let botAccountId = null;
let gambleActive = false;

const initBot = async () => {
    try {
        const me = await cw.get('/me');
        botAccountId = me.data.account_id.toString();
        const { data } = await supabase.from('config').select('value').eq('key', 'gamble_active').single();
        if (data) gambleActive = data.value === 'true';
    } catch (e) { console.error('Init Error', e.message); }
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

// --- ブラックリスト防衛処理 ---
const updateRoomMembers = async (roomId, targetIds) => {
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
        }
        if (!targetFound) return false; 
        const params = new URLSearchParams();
        if (admins.length > 0) params.append('members_admin_ids', admins.join(','));
        if (members.length > 0) params.append('members_member_ids', members.join(','));
        if (readonlys.length > 0) params.append('members_readonly_ids', readonlys.join(','));
        await cw.put(`/rooms/${roomId}/members`, params.toString());
        return true;
    } catch (err) {
        const errorDetail = err.response ? JSON.stringify(err.response.data) : err.message;
        await sendMessage(roomId, `[info][title]⚠️メンバー追放エラー[/title]${errorDetail}[/info]`);
        throw err;
    }
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
        if (toKick.length > 0) await updateRoomMembers(roomId, toKick);
    } catch (e) {}
};

// --- 深夜0時リセット処理 ---
const checkDailyReset = async (roomId) => {
    try {
        // 現在の日本時間 (UTC + 9時間) を取得
        const now = new Date();
        const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
        const todayStr = jst.toISOString().split('T')[0]; // 例: "2024-03-15"
        
        const { data } = await supabase.from('config').select('value').eq('key', 'last_reset_date').single();
        if (!data || data.value !== todayStr) {
            // DB上の日付が今日と違う（＝0時をまたいだ）場合、リセット実行
            await supabase.from('players').update({ money: 0, debt: 0, slot_count: 0 }).neq('account_id', '0');
            await supabase.from('config').upsert({ key: 'last_reset_date', value: todayStr });
            if (roomId) await sendMessage(roomId, `[info][title]🔄 日替わりリセット[/title]深夜0時になりました。全プレイヤーの所持金・借金・スロット回数がリセットされました！[/info]`);
        }
    } catch (e) {
        console.error("Reset Error", e.message);
    }
};


// --- Webhook メイン処理 ---
app.post('/webhook', async (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid Signature');

    const eventType = req.body.webhook_event_type;
    const event = req.body.webhook_event;
    if (!event || eventType !== 'message_created') return res.status(200).send('Ignored');

    const roomId = event.room_id;
    const body = event.body || "";
    const senderId = event.account_id.toString();
    const messageId = event.message_id;

    try {
        // --- ブラックリスト防衛 ---
        const { data: isBlacklisted } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId);
        if (isBlacklisted && isBlacklisted.length > 0) {
            await updateRoomMembers(roomId, [senderId]); 
            await deleteMessage(roomId, messageId); 
            return res.status(200).send('Kicked');
        }
        runPatrol(roomId);

        // --- ブラックリスト コマンド ---
        const isBlacklistCmd = /(^|\n)\/blacklist(\s|$)/.test(body);
        const isReblacklistCmd = /(^|\n)\/reblacklist(\s|$)/.test(body);

        if (isBlacklistCmd || isReblacklistCmd) {
            const isAdmin = await isUserAdmin(roomId, senderId);
            if (!isAdmin) return res.status(200).send('Forbidden');

            let targetAid = null;
            let commandType = 'list';
            const replyMatch = body.match(/\[(?:rp|qtmeta)\s+aid=([0-9]+)/);
            if (replyMatch) {
                targetAid = replyMatch[1]; commandType = isBlacklistCmd ? 'add' : 'remove';
            } else {
                const cmdMatch = body.match(/\/(?:blacklist|reblacklist)\s+([0-9]+)/);
                if (cmdMatch) { targetAid = cmdMatch[1]; commandType = isBlacklistCmd ? 'add' : 'remove'; } 
                else if (isReblacklistCmd) return res.status(200).send('No AID');
            }

            if (commandType === 'add' && targetAid) {
                const { data: existing } = await supabase.from('blacklist').select('account_id').eq('account_id', targetAid);
                if (existing && existing.length > 0) {
                    await sendMessage(roomId, `[info][piconname:${targetAid}] は【既に】ブラックリストに登録されています。[/info]`);
                } else {
                    await supabase.from('blacklist').insert({ account_id: targetAid });
                    await updateRoomMembers(roomId, [targetAid]);
                    await sendMessage(roomId, `[info][piconname:${targetAid}] をブラックリストに新規登録し、強制追放しました。[/info]`);
                }
                return res.status(200).send('OK');
            } 
            else if (commandType === 'remove' && targetAid) {
                const { data: existing } = await supabase.from('blacklist').select('account_id').eq('account_id', targetAid);
                if (!existing || existing.length === 0) {
                    await sendMessage(roomId, `[info][piconname:${targetAid}] はブラックリストに登録されていません。[/info]`);
                } else {
                    await supabase.from('blacklist').delete().eq('account_id', targetAid);
                    await sendMessage(roomId, `[info][piconname:${targetAid}] をブラックリストから解除しました。[/info]`);
                }
                return res.status(200).send('OK');
            } 
            else if (commandType === 'list') {
                const { data } = await supabase.from('blacklist').select('account_id');
                const listStr = data && data.length > 0 ? data.map(d => `[piconname:${d.account_id}] (ID: ${d.account_id})`).join('\n') : "登録なし";
                const resMsg = await sendMessage(roomId, `[info][title]ブラックリスト一覧[/title]${listStr}\n\n※1分後に自動消去されます[/info]`);
                if (resMsg && resMsg.data) setTimeout(() => deleteMessage(roomId, resMsg.data.message_id), 60000);
                return res.status(200).send('OK');
            }
        }

        // --- ギャンブル機能 コマンド ---
        if (body.startsWith('/st-gya')) {
            if (!(await isUserAdmin(roomId, senderId))) return res.status(200).send('Forbidden');
            gambleActive = true;
            await supabase.from('config').upsert({ key: 'gamble_active', value: 'true' });
            await supabase.from('players').update({ slot_count: 0 }).neq('account_id', '0');
            await sendMessage(roomId, `[info][title]🎰 ギャンブル開始[/title]ギャンブル機能が有効になりました！\n発言ごとに1コイン獲得できます。[/info]`);
            return res.status(200).send('OK');
        }
        
        if (body.startsWith('/fi-gya')) {
            if (!(await isUserAdmin(roomId, senderId))) return res.status(200).send('Forbidden');
            gambleActive = false;
            await supabase.from('config').upsert({ key: 'gamble_active', value: 'false' });
            await sendMessage(roomId, `[info]ギャンブル機能が無効になりました。[/info]`);
            return res.status(200).send('OK');
        }

        if (body.startsWith('/debt ')) {
            const amount = parseInt(body.split(/\s+/)[1], 10);
            if (isNaN(amount) || amount <= 0) return res.status(200).send('Invalid');
            const { data } = await supabase.from('players').select('*').eq('account_id', senderId).single();
            if (data) {
                await supabase.from('players').update({ money: data.money + amount, debt: data.debt + amount }).eq('account_id', senderId);
            } else {
                await supabase.from('players').insert({ account_id: senderId, money: amount, debt: amount, slot_count: 0 });
            }
            await sendMessage(roomId, `[info][piconname:${senderId}] ${amount} コインを借金しました！💸[/info]`);
            return res.status(200).send('OK');
        }

        if (body.startsWith('/give ')) {
            const parts = body.split(/\s+/);
            const targetAid = parts[1];
            const amount = parseInt(parts[2], 10);
            if (!targetAid || isNaN(amount) || amount <= 0) return res.status(200).send('Invalid');
            
            const { data: sender } = await supabase.from('players').select('*').eq('account_id', senderId).single();
            if (!sender || sender.money < amount) {
                await sendMessage(roomId, `[rp aid=${senderId}] 持ち金が足りません！`);
                return res.status(200).send('OK');
            }
            
            const { data: receiver } = await supabase.from('players').select('*').eq('account_id', targetAid).single();
            await supabase.from('players').update({ money: sender.money - amount }).eq('account_id', senderId);
            if (receiver) {
                await supabase.from('players').update({ money: receiver.money + amount }).eq('account_id', targetAid);
            } else {
                await supabase.from('players').insert({ account_id: targetAid, money: amount, debt: 0, slot_count: 0 });
            }
            await sendMessage(roomId, `[info][piconname:${senderId}] ➡ [piconname:${targetAid}]\n${amount} コインを送金しました。[/info]`);
            return res.status(200).send('OK');
        }

        if (body.trim() === '/money-rank') {
            const { data } = await supabase.from('players').select('*').order('money', { ascending: false }).limit(10);
            const listStr = data && data.length > 0 
                ? data.map((d, i) => `${i+1}位: [piconname:${d.account_id}] - ${d.money} コイン (借金: ${d.debt})`).join('\n') 
                : "データなし";
            const resMsg = await sendMessage(roomId, `[info][title]💰 所持金ランキング TOP10[/title]${listStr}\n\n※このメッセージは5分後に消去されます[/info]`);
            if (resMsg && resMsg.data) setTimeout(() => deleteMessage(roomId, resMsg.data.message_id), 300000);
            return res.status(200).send('OK');
        }

        if (body.trim() === '/slot') {
            if (!gambleActive) return res.status(200).send('Not active');
            await sendMessage(roomId, `[rp aid=${senderId} to=${roomId}-${messageId}]🎰掛け金をこのメッセージへの【返信】で送信してください。\n(※数字だけを入力してください。一人3回まで)`);
            return res.status(200).send('OK');
        }

        // --- スロット実行 ---
        if (gambleActive && botAccountId && body.includes(`[rp aid=${botAccountId}`) && body.includes('掛け金をこのメッセージへの')) {
            const textPart = body.replace(/\[.*?\]/g, '').trim();
            const betAmount = parseInt(textPart, 10);
            
            if (!isNaN(betAmount) && betAmount > 0) {
                const { data } = await supabase.from('players').select('*').eq('account_id', senderId).single();
                if (!data || data.money < betAmount) {
                    await sendMessage(roomId, `[rp aid=${senderId}] お金が足りません！ (所持: ${data ? data.money : 0}コイン)`);
                    return res.status(200).send('OK');
                }
                if (data.slot_count >= 3) {
                    await sendMessage(roomId, `[rp aid=${senderId}] 制限到達！スロットは1回のギャンブル開催につき一人3回までです。`);
                    return res.status(200).send('OK');
                }
                
                let newMoney = data.money - betAmount;
                let newCount = data.slot_count + 1;
                
                const rand = Math.floor(Math.random() * 100);
                let multiplier = 0; let symbolResult = ""; let msgResult = "";
                
                if (rand === 0) { // 1%
                    multiplier = 100; symbolResult = "🐉 | 🐉 | 🐉"; msgResult = "超大当たり！！！ (100倍)";
                } else if (rand <= 3) { // 3%
                    multiplier = 10; symbolResult = "7️⃣ | 7️⃣ | 7️⃣"; msgResult = "大当たり！ (10倍)";
                } else if (rand <= 9) { // 6%
                    multiplier = 3; const sym = ["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)];
                    symbolResult = `${sym} | ${sym} | ${sym}`; msgResult = "当たり！ (3倍)";
                } else if (rand <= 19) { // 10%
                    multiplier = 2; const sym = ["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)];
                    symbolResult = `${sym} | ${sym} | ${sym}`; msgResult = "当たり！ (2倍)";
                } else if (rand <= 29) { // 10% (指定外のフルーツ等でも3つ揃えば当たり)
                    multiplier = 2; const sym = ["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)];
                    symbolResult = `${sym} | ${sym} | ${sym}`; msgResult = "フルーツ揃い！当たり！ (2倍)";
                } else if (rand <= 49) { // 20% (チェリー出現)
                    multiplier = 2; const others = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"];
                    const resSyms = ["🍒", others[Math.floor(Math.random()*others.length)], others[Math.floor(Math.random()*others.length)]];
                    resSyms.sort(() => Math.random() - 0.5);
                    symbolResult = resSyms.join(" | "); msgResult = "チェリー出現！ (2倍)";
                } else { // 50%
                    multiplier = 0; const others = ["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"];
                    let r1 = others[Math.floor(Math.random()*others.length)];
                    let r2 = others[Math.floor(Math.random()*others.length)];
                    let r3 = others[Math.floor(Math.random()*others.length)];
                    while (r1 === r2 && r2 === r3) r3 = others[Math.floor(Math.random()*others.length)];
                    symbolResult = `${r1} | ${r2} | ${r3}`; msgResult = "はずれ！";
                }
                
                const winAmount = betAmount * multiplier;
                newMoney += winAmount;
                
                await supabase.from('players').update({ money: newMoney, slot_count: newCount }).eq('account_id', senderId);
                await sendMessage(roomId, `[rp aid=${senderId}]\n🎰 スロット結果 🎰\n【 ${symbolResult} 】\n${msgResult}\n賭け金: ${betAmount} ➡ 獲得: ${winAmount} コイン\n(残り回数: ${3 - newCount}回)`);
                return res.status(200).send('OK');
            }
        }

        // --- コイン付与 (発言ごとに1コイン) ---
        if (gambleActive) {
            supabase.from('players').select('*').eq('account_id', senderId).single().then(async ({ data }) => {
                if (data) await supabase.from('players').update({ money: data.money + 1 }).eq('account_id', senderId);
                else await supabase.from('players').insert({ account_id: senderId, money: 1, debt: 0, slot_count: 0 });
            }).catch(()=>{});
        }

    } catch (error) {
        console.error("Critical Error:", error);
    }
    res.status(200).send('OK');
});

// --- ループ処理 (パトロール & 0時リセット監視) ---
setInterval(() => {
    if (TARGET_ROOM_ID) {
        runPatrol(TARGET_ROOM_ID);
        checkDailyReset(TARGET_ROOM_ID);
    }
}, 10000);

app.get('/', (req, res) => res.send('Bot is Live - V11 (Gamble Edition)'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));
