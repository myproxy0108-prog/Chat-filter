const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const API_TOKEN = process.env.CHATWORK_API_TOKEN;
const WEBHOOK_TOKEN = process.env.CHATWORK_WEBHOOK_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // ※必ずservice_roleキーにしてください
const TARGET_ROOM_ID = process.env.TARGET_ROOM_ID; 

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});

const verifySignature = (req) => {
    const signature = req.headers['x-chatworkwebhooksignature'];
    if (!signature) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return signature === expected;
};

const sendMessage = (roomId, text) => cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`).catch(()=>{});
const deleteMessage = (roomId, messageId) => cw.delete(`/rooms/${roomId}/messages/${messageId}`).catch(()=>{});

const updateRoomMembers = async (roomId, targetIds) => {
    try {
        const { data: currentMembers } = await cw.get(`/rooms/${roomId}/members`);
        
        let admins = currentMembers.filter(m => m.role === 'admin' || m.role === 'creator').map(m => m.account_id.toString());
        let members = currentMembers.filter(m => m.role === 'member').map(m => m.account_id.toString());
        let readonlys = currentMembers.filter(m => m.role === 'readonly').map(m => m.account_id.toString());

        let targetFound = false;

        for (const aid of targetIds) {
            const idStr = aid.toString();
            if (admins.includes(idStr) || members.includes(idStr) || readonlys.includes(idStr)) {
                targetFound = true;
            }
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
        await sendMessage(roomId, `[info][title]⚠️キック失敗[/title]Chatworkにキックをブロックされました:\n${errorDetail}[/info]`);
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
        const { data: blacklist } = await supabase.from('blacklist').select('account_id');
        if (!members || !blacklist || blacklist.length === 0) return;

        const blacklistedIds = blacklist.map(b => b.account_id);
        const toKick = members
            .filter(m => blacklistedIds.includes(m.account_id.toString()))
            .map(m => m.account_id.toString());
        
        if (toKick.length > 0) {
            const kicked = await updateRoomMembers(roomId, toKick);
            if (kicked) {
                await sendMessage(roomId, `[info]【自動防衛作動】\nブラックリスト対象者の侵入を検知し、即座に追放しました。\n(ID: ${toKick.join(', ')})[/info]`);
            }
        }
    } catch (e) {
        // パトロール時のエラーは無視
    }
};

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
        // 1. ブラックリスト本人が発言したら即キック
        const { data: isBlacklisted } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId);
        if (isBlacklisted && isBlacklisted.length > 0) {
            await updateRoomMembers(roomId, [senderId]); 
            await deleteMessage(roomId, messageId); 
            return res.status(200).send('Kicked');
        }

        // 2. パトロール作動
        runPatrol(roomId);

        // 3. コマンド処理
        const isBlacklistCmd = /(^|\n)\/blacklist(\s|$)/.test(body);
        const isReblacklistCmd = /(^|\n)\/reblacklist(\s|$)/.test(body);

        if (isBlacklistCmd || isReblacklistCmd) {
            const isAdmin = await isUserAdmin(roomId, senderId);
            if (!isAdmin) return res.status(200).send('Forbidden');

            let targetAid = null;
            let commandType = 'list';

            const replyMatch = body.match(/\[(?:rp|qtmeta)\s+aid=([0-9]+)/);
            if (replyMatch) {
                targetAid = replyMatch[1];
                commandType = isBlacklistCmd ? 'add' : 'remove';
            } else {
                const cmdMatch = body.match(/\/(?:blacklist|reblacklist)\s+([0-9]+)/);
                if (cmdMatch) {
                    targetAid = cmdMatch[1];
                    commandType = isBlacklistCmd ? 'add' : 'remove';
                } else if (isReblacklistCmd) {
                    return res.status(200).send('No AID');
                }
            }

            // 【新規】登録済みかどうかの判定処理
            if (commandType === 'add' && targetAid) {
                const { data: existing } = await supabase.from('blacklist').select('account_id').eq('account_id', targetAid);
                if (existing && existing.length > 0) {
                    // 既に登録されている場合
                    await sendMessage(roomId, `[info]対象者(ID: ${targetAid}) は既にブラックリストに登録されています。[/info]`);
                } else {
                    // 新規登録
                    await supabase.from('blacklist').insert({ account_id: targetAid });
                    await updateRoomMembers(roomId, [targetAid]);
                    await sendMessage(roomId, `[info]対象者(ID: ${targetAid})をブラックリストに登録し、強制追放しました。[/info]`);
                }
            } 
            else if (commandType === 'remove' && targetAid) {
                const { data: existing } = await supabase.from('blacklist').select('account_id').eq('account_id', targetAid);
                if (!existing || existing.length === 0) {
                    // 登録されていない場合
                    await sendMessage(roomId, `[info]対象者(ID: ${targetAid}) はブラックリストに登録されていません。[/info]`);
                } else {
                    // 解除
                    await supabase.from('blacklist').delete().eq('account_id', targetAid);
                    await sendMessage(roomId, `[info]対象者(ID: ${targetAid})をブラックリストから解除しました。[/info]`);
                }
            } 
            else if (commandType === 'list') {
                const { data } = await supabase.from('blacklist').select('account_id');
                const listStr = data && data.length > 0 ? data.map(d => d.account_id).join('\n') : "登録なし";
                const resMsg = await sendMessage(roomId, `[info][title]ブラックリスト一覧[/title]${listStr}\n\n※1分後に自動消去されます[/info]`);
                setTimeout(() => deleteMessage(roomId, resMsg.data.message_id), 60000);
            }
        }
    } catch (error) {
        console.error("Error:", error);
    }
    res.status(200).send('OK');
});

setInterval(() => {
    if (TARGET_ROOM_ID) runPatrol(TARGET_ROOM_ID);
}, 10000);

app.get('/', (req, res) => res.send('Bot is Live - V7'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));
