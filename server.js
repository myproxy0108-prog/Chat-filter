const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
}));

const API_TOKEN = 5fdb19e36219b23ca5d54fa880157873;
const WEBHOOK_TOKEN = 5fdb19e36219b23ca5d54fa880157873;

const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 
        'X-ChatWorkToken': API_TOKEN,
        'Content-Type': 'application/x-www-form-urlencoded'
    }
});

// ブラックリスト保持用
let blacklist = new Set();

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

// ヘルパー: メッセージ送信
const sendMessage = (roomId, text) => cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`);
// ヘルパー: メッセージ削除
const deleteMessage = (roomId, messageId) => cw.delete(`/rooms/${roomId}/messages/${messageId}`);

// --- Webhook 受信 ---
app.post('/webhook', async (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid Signature');

    const eventType = req.body.webhook_event_type;
    const event = req.body.webhook_event;

    try {
        // 1. メッセージイベント（コマンド処理）
        if (eventType === 'message_sent') {
            const roomId = event.room_id;
            const body = event.body || "";

            // /blacklist aid: ブラックリスト追加 ＋ 閲覧のみに格下げ
            if (body.startsWith('/blacklist ')) {
                const aid = body.split(/\s+/)[1];
                if (aid) {
                    blacklist.add(aid);
                    // 既に部屋にいる場合は権限を「閲覧のみ」に変更
                    await cw.put(`/rooms/${roomId}/members`, `members_readonly_ids=${aid}`);
                    await sendMessage(roomId, `[info][title]ブラックリスト登録[/title]Account ID: ${aid} をブラックリストに登録し、権限を「閲覧のみ」に変更しました。[/info]`);
                }
            } 
            // /reblacklist aid: ブラックリスト解除
            else if (body.startsWith('/reblacklist ')) {
                const aid = body.split(/\s+/)[1];
                if (aid) {
                    blacklist.delete(aid);
                    await sendMessage(roomId, `[info]Account ID: ${aid} をブラックリストから解除しました。[/info]`);
                }
            } 
            // /blacklist: 一覧表示
            else if (body.trim() === '/blacklist') {
                const listStr = blacklist.size > 0 ? Array.from(blacklist).join('\n') : "登録なし";
                const resMsg = await sendMessage(roomId, `[info][title]ブラックリスト一覧[/title]${listStr}\n\n(1分後に消去されます)[/info]`);
                setTimeout(() => deleteMessage(roomId, resMsg.data.message_id).catch(e => {}), 60000);
            }
        }

        // 2. 参加申請イベント（自動承認ロジック）
        if (eventType === 'member_add_request') {
            const roomId = event.room_id;
            const applicants = event.applicants || [];

            for (const aid of applicants) {
                const accountId = aid.toString();
                
                if (blacklist.has(accountId)) {
                    // ブラックリスト内の人は「閲覧のみ(readonly)」で承認
                    await cw.put(`/rooms/${roomId}/members`, `members_readonly_ids=${accountId}`);
                    await sendMessage(roomId, `[info]ブラックリスト対象者(ID: ${accountId})の申請を「閲覧のみ」で承認しました。[/info]`);
                } else {
                    // それ以外の人は「メンバー(member)」で承認
                    await cw.put(`/rooms/${roomId}/members`, `members_member_ids=${accountId}`);
                    await sendMessage(roomId, `[info]Account ID: ${accountId} の参加申請を承認しました。[/info]`);
                }
            }
        }

    } catch (error) {
        console.error("Error:", error.response ? error.response.data : error.message);
    }

    res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('Bot is active.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
