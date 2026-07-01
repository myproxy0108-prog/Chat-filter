const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

const API_TOKEN = process.env.CHATWORK_API_TOKEN;
const WEBHOOK_TOKEN = process.env.CHATWORK_WEBHOOK_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 
        'X-ChatWorkToken': API_TOKEN,
        'Content-Type': 'application/x-www-form-urlencoded'
    }
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

// 【最重要修正】メンバーを安全に変更する関数
const updateRoomMembers = async (roomId, targetIds, roleToAdd) => {
    try {
        // 1. 今の部屋の全メンバーを取得
        const { data: currentMembers } = await cw.get(`/rooms/${roomId}/members`);
        
        // 2. 現在の役職ごとにIDを振り分け
        let admins = currentMembers.filter(m => m.role === 'admin' || m.role === 'creator').map(m => m.account_id.toString());
        let members = currentMembers.filter(m => m.role === 'member').map(m => m.account_id.toString());
        let readonlys = currentMembers.filter(m => m.role === 'readonly').map(m => m.account_id.toString());

        // 3. 対象者を一旦すべてのリストから抜き取る（重複防止）
        for (const aid of targetIds) {
            const idStr = aid.toString();
            admins = admins.filter(id => id !== idStr);
            members = members.filter(id => id !== idStr);
            readonlys = readonlys.filter(id => id !== idStr);
        }

        // 4. 対象者を希望の役職リストに投入
        for (const aid of targetIds) {
            const idStr = aid.toString();
            if (roleToAdd === 'admin') admins.push(idStr);
            else if (roleToAdd === 'member') members.push(idStr);
            else if (roleToAdd === 'readonly') readonlys.push(idStr);
        }

        // 5. URLエンコード形式で全員分のデータを再送信（これで他の人が消えない）
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
    } catch (e) {
        return false;
    }
};


// --- Webhook メイン処理 ---
app.post('/webhook', async (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid Signature');

    const eventType = req.body.webhook_event_type;
    const event = req.body.webhook_event;
    if (!event) return res.status(200).send('No event');

    const roomId = event.room_id;

    try {
        // A. メッセージ受信 (コマンド)
        if (eventType === 'message_sent') {
            const body = event.body || "";
            const senderId = event.account_id;

            if (body.startsWith('/blacklist') || body.startsWith('/reblacklist')) {
                const isAdmin = await isUserAdmin(roomId, senderId);
                if (!isAdmin) return res.status(200).send('Forbidden');

                if (body.startsWith('/blacklist ')) {
                    const aid = body.split(/\s+/)[1];
                    if (aid) {
                        await supabase.from('blacklist').upsert({ account_id: aid });
                        // 修正: メンバー全体を更新する関数を呼び出す
                        await updateRoomMembers(roomId, [aid], 'readonly');
                        await sendMessage(roomId, `[info]ID: ${aid} をブラックリストに登録し、権限を「閲覧のみ」に変更しました。[/info]`);
                    }
                }
                else if (body.startsWith('/reblacklist ')) {
                    const aid = body.split(/\s+/)[1];
                    if (aid) {
                        await supabase.from('blacklist').delete().eq('account_id', aid);
                        await sendMessage(roomId, `[info]ID: ${aid} をブラックリストから解除しました。[/info]`);
                    }
                }
                else if (body.trim() === '/blacklist') {
                    const { data } = await supabase.from('blacklist').select('account_id');
                    const listStr = data && data.length > 0 ? data.map(d => d.account_id).join('\n') : "登録なし";
                    const resMsg = await sendMessage(roomId, `[info][title]ブラックリスト一覧[/title]${listStr}\n\n※1分後に消去されます[/info]`);
                    setTimeout(() => deleteMessage(roomId, resMsg.data.message_id).catch(() => {}), 60000);
                }
            }
        }

        // B. 参加申請イベント
        if (eventType === 'member_add_request') {
            const applicants = event.applicants || [];
            let readOnlyTargets = [];
            let normalTargets = [];

            // 1. 全ての申請者をチェックし、ブラック/ホワイトに仕分け
            for (const aid of applicants) {
                const accountId = aid.toString();
                const { data } = await supabase.from('blacklist').select('*').eq('account_id', accountId).single();
                if (data) {
                    readOnlyTargets.push(accountId);
                } else {
                    normalTargets.push(accountId);
                }
            }

            // 2. まとめて部屋に追加 (他の人は消えません)
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
        // 万が一エラーが起きてもチャットに報告させる
        await sendMessage(roomId, `[info][title]システムエラー[/title]${error.message}[/info]`);
    }

    res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('Bot is Live - V2'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));
