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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});

// --- ヘルパー関数 ---
const verifySignature = (req) => {
    const signature = req.headers['x-chatworkwebhooksignature'];
    if (!signature) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return signature === expected;
};

const sendMessage = (roomId, text) => cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`);
const deleteMessage = (roomId, messageId) => cw.delete(`/rooms/${roomId}/messages/${messageId}`);

const updateRoomMembers = async (roomId, targetIds, roleToAdd) => {
    try {
        const { data: currentMembers } = await cw.get(`/rooms/${roomId}/members`);
        
        let admins = currentMembers.filter(m => m.role === 'admin' || m.role === 'creator').map(m => m.account_id.toString());
        let members = currentMembers.filter(m => m.role === 'member').map(m => m.account_id.toString());
        let readonlys = currentMembers.filter(m => m.role === 'readonly').map(m => m.account_id.toString());

        for (const aid of targetIds) {
            const idStr = aid.toString();
            admins = admins.filter(id => id !== idStr);
            members = members.filter(id => id !== idStr);
            readonlys = readonlys.filter(id => id !== idStr);
            
            if (roleToAdd === 'admin') admins.push(idStr);
            else if (roleToAdd === 'member') members.push(idStr);
            else if (roleToAdd === 'readonly') readonlys.push(idStr);
        }

        const params = new URLSearchParams();
        if (admins.length > 0) params.append('members_admin_ids', admins.join(','));
        if (members.length > 0) params.append('members_member_ids', members.join(','));
        if (readonlys.length > 0) params.append('members_readonly_ids', readonlys.join(','));

        await cw.put(`/rooms/${roomId}/members`, params.toString());
    } catch (err) {
        console.error("Member update error:", err.response ? err.response.data : err.message);
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

// --- Webhook メイン処理 ---
app.post('/webhook', async (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid Signature');

    const eventType = req.body.webhook_event_type;
    const event = req.body.webhook_event;
    if (!event) return res.status(200).send('No event');

    const roomId = event.room_id;

    try {
        if (eventType === 'message_sent') {
            const body = event.body || "";
            const senderId = event.account_id;

            // コマンドが含まれているか判定
            const isBlacklistCmd = /(^|\n)\/blacklist(\s|$)/.test(body);
            const isReblacklistCmd = /(^|\n)\/reblacklist(\s|$)/.test(body);

            if (isBlacklistCmd || isReblacklistCmd) {
                // 管理者チェック
                const isAdmin = await isUserAdmin(roomId, senderId);
                if (!isAdmin) return res.status(200).send('Forbidden');

                let targetAid = null;
                let commandType = 'list'; // list, add, remove

                // 1. 返信タグ [rp aid=...] または 引用タグ [qtmeta aid=...] からIDを抽出
                const replyMatch = body.match(/\[(?:rp|qtmeta)\s+aid=([0-9]+)/);
                if (replyMatch) {
                    targetAid = replyMatch[1];
                    commandType = isBlacklistCmd ? 'add' : 'remove';
                } else {
                    // 2. 返信でない場合はスペース区切りの数字を探す (/blacklist 12345)
                    const cmdMatch = body.match(/\/(?:blacklist|reblacklist)\s+([0-9]+)/);
                    if (cmdMatch) {
                        targetAid = cmdMatch[1];
                        commandType = isBlacklistCmd ? 'add' : 'remove';
                    } else if (isReblacklistCmd) {
                        return res.status(200).send('No AID specified');
                    }
                }

                // --- 実行処理 ---
                if (commandType === 'add' && targetAid) {
                    await supabase.from('blacklist').upsert({ account_id: targetAid });
                    await updateRoomMembers(roomId, [targetAid], 'readonly');
                    await sendMessage(roomId, `[info]対象者 (ID: ${targetAid}) をブラックリストに追加し、「閲覧のみ」に変更しました。[/info]`);
                } 
                else if (commandType === 'remove' && targetAid) {
                    await supabase.from('blacklist').delete().eq('account_id', targetAid);
                    // 解除後、通常のメンバーに戻す
                    await updateRoomMembers(roomId, [targetAid], 'member');
                    await sendMessage(roomId, `[info]対象者 (ID: ${targetAid}) をブラックリストから解除し、「メンバー」に戻しました。[/info]`);
                } 
                else if (commandType === 'list') {
                    const { data } = await supabase.from('blacklist').select('account_id');
                    const listStr = data && data.length > 0 ? data.map(d => d.account_id).join('\n') : "登録なし";
                    const resMsg = await sendMessage(roomId, `[info][title]ブラックリスト一覧[/title]${listStr}\n\n※1分後に消去されます[/info]`);
                    setTimeout(() => deleteMessage(roomId, resMsg.data.message_id).catch(() => {}), 60000);
                }
            }
        }

        // 参加申請イベント
        if (eventType === 'member_add_request') {
            const applicants = event.applicants || [];
            let readOnlyTargets = [];
            let normalTargets = [];

            for (const aid of applicants) {
                const accountId = aid.toString();
                const { data } = await supabase.from('blacklist').select('*').eq('account_id', accountId).single();
                if (data) readOnlyTargets.push(accountId);
                else normalTargets.push(accountId);
            }

            if (readOnlyTargets.length > 0) {
                await updateRoomMembers(roomId, readOnlyTargets, 'readonly');
                await sendMessage(roomId, `[info]ブラックリスト照合: ${readOnlyTargets.join(', ')} を「閲覧のみ」で承認しました。[/info]`);
            }
            if (normalTargets.length > 0) {
                await updateRoomMembers(roomId, normalTargets, 'member');
                await sendMessage(roomId, `[info]自動承認: ${normalTargets.join(', ')} を通常メンバーとして承認しました。[/info]`);
            }
        }
    } catch (error) {
        console.error("Error:", error);
    }
    res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('Bot is Live - V3'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));
