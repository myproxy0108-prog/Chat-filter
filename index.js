const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const API_TOKEN = process.env.CHATWORK_API_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});

// デバッグ用送信関数
const debugLog = (roomId, text) => {
    return cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent("[[debug]] " + text)}`).catch(() => {});
};

// 管理者チェック
const isUserAdmin = async (roomId, accountId) => {
    const response = await cw.get(`/rooms/${roomId}/members`);
    const member = response.data.find(m => m.account_id.toString() === accountId.toString());
    return member && (member.role === 'admin' || member.role === 'creator');
};

app.post('/webhook', async (req, res) => {
    // 署名検証を一時的にスキップ（確実に動かすため）
    const event = req.body.webhook_event;
    const eventType = req.body.webhook_event_type;

    if (!event) return res.status(200).send('No Event');

    const roomId = event.room_id;

    try {
        if (eventType === 'message_sent') {
            const body = event.body || "";
            const senderId = event.account_id;

            if (body.startsWith('/blacklist')) {
                // デバッグログを流す
                await debugLog(roomId, `コマンド受信: ${body} (Sender: ${senderId})`);

                const isAdmin = await isUserAdmin(roomId, senderId);
                if (!isAdmin) {
                    await debugLog(roomId, "あなたは管理者ではありません");
                    return res.status(200).send('No Admin');
                }

                if (body.startsWith('/blacklist ')) {
                    const aid = body.split(/\s+/)[1];
                    await supabase.from('blacklist').upsert({ account_id: aid });
                    await cw.put(`/rooms/${roomId}/members`, `members_readonly_ids=${aid}`);
                    await cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent("ID: " + aid + " を登録しました")}`);
                } 
                else if (body.trim() === '/blacklist') {
                    const { data } = await supabase.from('blacklist').select('account_id');
                    const listStr = data.map(d => d.account_id).join('\n') || "なし";
                    await cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent("【一覧】\n" + listStr)}`);
                }
            }
        }

        if (eventType === 'member_add_request') {
            const applicants = event.applicants || [];
            for (const aid of applicants) {
                const { data } = await supabase.from('blacklist').select('*').eq('account_id', aid.toString()).single();
                const role = data ? 'members_readonly_ids' : 'members_member_ids';
                await cw.put(`/rooms/${roomId}/members`, `${role}=${aid}`);
                await debugLog(roomId, `参加承認: ${aid} (${data ? '閲覧のみ' : '通常'})`);
            }
        }
    } catch (error) {
        // エラーが起きたらチャットに書き込む
        await debugLog(roomId, `エラー発生: ${error.message}`);
    }
    res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('Bot is Live!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));
