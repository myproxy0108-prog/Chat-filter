const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- 環境変数 ---
const API_TOKEN = process.env.CHATWORK_API_TOKEN;
const WEBHOOK_TOKEN = process.env.CHATWORK_WEBHOOK_TOKEN; // 5fdb19e36219b23ca5d54fa880157873
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// --- 初期化 ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 
        'X-ChatWorkToken': API_TOKEN,
        'Content-Type': 'application/x-www-form-urlencoded'
    }
});

// 署名検証
const verifySignature = (req) => {
    const signature = req.headers['x-chatworkwebhooksignature'];
    if (!signature) return false;
    const expectedSignature = crypto
        .createHmac('sha256', Buffer.from(WEBHOOK_TOKEN, 'base64'))
        .update(req.rawBody)
        .digest('base64');
    return signature === expectedSignature;
};

const sendMessage = (roomId, text) => cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`);
const deleteMessage = (roomId, messageId) => cw.delete(`/rooms/${roomId}/messages/${messageId}`);

// --- メイン処理 ---
app.post('/webhook', async (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid Signature');

    const eventType = req.body.webhook_event_type;
    const event = req.body.webhook_event;

    try {
        // 1. コマンド処理 (メッセージ送信イベント)
        if (eventType === 'message_sent') {
            const roomId = event.room_id;
            const body = event.body || "";

            // /blacklist aid
            if (body.startsWith('/blacklist ')) {
                const aid = body.split(/\s+/)[1];
                if (aid) {
                    await supabase.from('blacklist').upsert({ account_id: aid });
                    await cw.put(`/rooms/${roomId}/members`, `members_readonly_ids=${aid}`);
                    await sendMessage(roomId, `[info][title]完了[/title]ID: ${aid} をブラックリスト(Supabase)に登録し、閲覧のみに変更しました。[/info]`);
                }
            }
            // /reblacklist aid
            else if (body.startsWith('/reblacklist ')) {
                const aid = body.split(/\s+/)[1];
                if (aid) {
                    await supabase.from('blacklist').delete().eq('account_id', aid);
                    await sendMessage(roomId, `[info]ID: ${aid} をブラックリストから削除しました。[/info]`);
                }
            }
            // /blacklist (一覧)
            else if (body.trim() === '/blacklist') {
                const { data } = await supabase.from('blacklist').select('account_id');
                const listStr = data.length > 0 ? data.map(d => d.account_id).join('\n') : "なし";
                const resMsg = await sendMessage(roomId, `[info][title]ブラックリスト一覧[/title]${listStr}\n\n(1分後に消去します)[/info]`);
                setTimeout(() => deleteMessage(roomId, resMsg.data.message_id).catch(() => {}), 60000);
            }
        }

        // 2. 参加申請処理
        if (eventType === 'member_add_request') {
            const roomId = event.room_id;
            const applicants = event.applicants || [];

            for (const aid of applicants) {
                const accountId = aid.toString();
                // Supabaseで検索
                const { data } = await supabase.from('blacklist').select('*').eq('account_id', accountId).single();

                if (data) {
                    // ブラックリストに存在する場合：閲覧のみで承認
                    await cw.put(`/rooms/${roomId}/members`, `members_readonly_ids=${accountId}`);
                    await sendMessage(roomId, `[info]判定：ID ${accountId} はブラックリストのため「閲覧のみ」で承認しました。[/info]`);
                } else {
                    // 存在しない場合：通常のメンバーとして承認
                    await cw.put(`/rooms/${roomId}/members`, `members_member_ids=${accountId}`);
                    await sendMessage(roomId, `[info]判定：ID ${accountId} を通常メンバーとして承認しました。[/info]`);
                }
            }
        }
    } catch (error) {
        console.error("Error:", error.response ? error.response.data : error.message);
    }
    res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('Chatwork Bot with Supabase is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
