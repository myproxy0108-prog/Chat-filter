const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Webhookの署名検証のために生のボディが必要
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// --- 環境変数の取得 ---
const API_TOKEN = process.env.CHATWORK_API_TOKEN;
const WEBHOOK_TOKEN = process.env.CHATWORK_WEBHOOK_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// --- クライアント初期化 ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 
        'X-ChatWorkToken': API_TOKEN,
        'Content-Type': 'application/x-www-form-urlencoded'
    }
});

// --- ヘルパー関数 ---

// 1. Webhook署名検証
const verifySignature = (req) => {
    const signature = req.headers['x-chatworkwebhooksignature'];
    if (!signature) return false;
    const expectedSignature = crypto
        .createHmac('sha256', Buffer.from(WEBHOOK_TOKEN, 'base64'))
        .update(req.rawBody)
        .digest('base64');
    return signature === expectedSignature;
};

// 2. メッセージ送信
const sendMessage = (roomId, text) => cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`);

// 3. メッセージ削除
const deleteMessage = (roomId, messageId) => cw.delete(`/rooms/${roomId}/messages/${messageId}`);

// 4. 管理者権限チェック
const isUserAdmin = async (roomId, accountId) => {
    try {
        const response = await cw.get(`/rooms/${roomId}/members`);
        const member = response.data.find(m => m.account_id.toString() === accountId.toString());
        return member && (member.role === 'admin' || member.role === 'creator');
    } catch (e) {
        console.error("Admin check failed:", e.message);
        return false;
    }
};

// --- Webhook メインハンドラー ---
app.post('/webhook', async (req, res) => {
    // 署名が正しくない場合は即終了
    if (!verifySignature(req)) return res.status(401).send('Invalid Signature');

    const eventType = req.body.webhook_event_type;
    const event = req.body.webhook_event;

    try {
        // A. メッセージ受信イベント (コマンド処理)
        if (eventType === 'message_sent') {
            const roomId = event.room_id;
            const body = event.body || "";
            const senderId = event.account_id;

            // コマンド判定
            if (body.startsWith('/blacklist') || body.startsWith('/reblacklist')) {
                // 管理者以外は実行不可
                const isAdmin = await isUserAdmin(roomId, senderId);
                if (!isAdmin) return res.status(200).send('Forbidden');

                // 1. /blacklist <aid>
                if (body.startsWith('/blacklist ')) {
                    const aid = body.split(/\s+/)[1];
                    if (aid) {
                        await supabase.from('blacklist').upsert({ account_id: aid });
                        await cw.put(`/rooms/${roomId}/members`, `members_readonly_ids=${aid}`);
                        await sendMessage(roomId, `[info][title]Blacklist Added[/title]Account ID: ${aid} を登録し「閲覧のみ」に変更しました。[/info]`);
                    }
                }
                // 2. /reblacklist <aid>
                else if (body.startsWith('/reblacklist ')) {
                    const aid = body.split(/\s+/)[1];
                    if (aid) {
                        await supabase.from('blacklist').delete().eq('account_id', aid);
                        await sendMessage(roomId, `[info]Account ID: ${aid} をリストから解除しました。[/info]`);
                    }
                }
                // 3. /blacklist (一覧表示)
                else if (body.trim() === '/blacklist') {
                    const { data } = await supabase.from('blacklist').select('account_id');
                    const listStr = data.length > 0 ? data.map(d => d.account_id).join('\n') : "登録なし";
                    const resMsg = await sendMessage(roomId, `[info][title]ブラックリスト一覧[/title]${listStr}\n\n※このメッセージは1分後に自動消去されます。[/info]`);
                    
                    // 1分後にメッセージを削除
                    setTimeout(() => {
                        deleteMessage(roomId, resMsg.data.message_id).catch(() => {});
                    }, 60000);
                }
            }
        }

        // B. 参加申請イベント (自動承認ロジック)
        if (eventType === 'member_add_request') {
            const roomId = event.room_id;
            const applicants = event.applicants || [];

            for (const aid of applicants) {
                const accountId = aid.toString();
                // Supabaseでブラックリストに入っているか確認
                const { data: isBlacklisted } = await supabase
                    .from('blacklist')
                    .select('*')
                    .eq('account_id', accountId)
                    .single();

                if (isBlacklisted) {
                    // ブラックリスト対象者：閲覧のみ権限で承認
                    await cw.put(`/rooms/${roomId}/members`, `members_readonly_ids=${accountId}`);
                    await sendMessage(roomId, `[info]Blacklist Alert: ID ${accountId} を「閲覧のみ」で承認しました。[/info]`);
                } else {
                    // ホワイト：通常メンバーとして承認
                    await cw.put(`/rooms/${roomId}/members`, `members_member_ids=${accountId}`);
                    await sendMessage(roomId, `[info]自動承認: ID ${accountId} が参加しました。[/info]`);
                }
            }
        }
    } catch (error) {
        console.error("Error Processing Webhook:", error.response ? error.response.data : error.message);
    }

    res.status(200).send('OK');
});

// ヘルスチェック用
app.get('/', (req, res) => res.send('Bot is Online'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
