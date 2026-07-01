const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- 環境変数 ---
const API_TOKEN = process.env.CHATWORK_API_TOKEN;
const WEBHOOK_TOKEN = process.env.CHATWORK_WEBHOOK_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TARGET_ROOM_ID = process.env.TARGET_ROOM_ID; // 新規追加: 監視する部屋のID

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});

// 署名検証
const verifySignature = (req) => {
    const signature = req.headers['x-chatworkwebhooksignature'];
    if (!signature) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return signature === expected;
};

// ヘルパー関数
const sendMessage = (roomId, text) => cw.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`).catch(()=>{});
const deleteMessage = (roomId, messageId) => cw.delete(`/rooms/${roomId}/messages/${messageId}`).catch(()=>{});

// 【キック機能】対象者をリストから除外して上書きする
const updateRoomMembers = async (roomId, targetIds) => {
    try {
        const { data: currentMembers } = await cw.get(`/rooms/${roomId}/members`);
        
        let admins = currentMembers.filter(m => m.role === 'admin' || m.role === 'creator').map(m => m.account_id.toString());
        let members = currentMembers.filter(m => m.role === 'member').map(m => m.account_id.toString());
        let readonlys = currentMembers.filter(m => m.role === 'readonly').map(m => m.account_id.toString());

        for (const aid of targetIds) {
            const idStr = aid.toString();
            // 全ての役職リストから対象者を消し去る ＝ キックされる
            admins = admins.filter(id => id !== idStr);
            members = members.filter(id => id !== idStr);
            readonlys = readonlys.filter(id => id !== idStr);
        }

        const params = new URLSearchParams();
        if (admins.length > 0) params.append('members_admin_ids', admins.join(','));
        if (members.length > 0) params.append('members_member_ids', members.join(','));
        if (readonlys.length > 0) params.append('members_readonly_ids', readonlys.join(','));

        await cw.put(`/rooms/${roomId}/members`, params.toString());
    } catch (err) {
        console.error("Member update error:", err.message);
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

    // 【修正】本当のイベント名は message_created です
    const eventType = req.body.webhook_event_type;
    const event = req.body.webhook_event;
    if (!event || eventType !== 'message_created') return res.status(200).send('Ignored');

    const roomId = event.room_id;
    const body = event.body || "";
    const senderId = event.account_id.toString();
    const messageId = event.message_id;

    try {
        // 1. もしブラックリスト本人が発言したら、即座に発言を消してキックする
        const { data: isBlacklisted } = await supabase.from('blacklist').select('*').eq('account_id', senderId).single();
        if (isBlacklisted) {
            await deleteMessage(roomId, messageId);
            await updateRoomMembers(roomId, [senderId]);
            return res.status(200).send('Kicked');
        }

        // 2. コマンド処理
        const isBlacklistCmd = /(^|\n)\/blacklist(\s|$)/.test(body);
        const isReblacklistCmd = /(^|\n)\/reblacklist(\s|$)/.test(body);

        if (isBlacklistCmd || isReblacklistCmd) {
            const isAdmin = await isUserAdmin(roomId, senderId);
            if (!isAdmin) return res.status(200).send('Forbidden');

            let targetAid = null;
            let commandType = 'list';

            // 返信タグからの抽出
            const replyMatch = body.match(/\[(?:rp|qtmeta)\s+aid=([0-9]+)/);
            if (replyMatch) {
                targetAid = replyMatch[1];
                commandType = isBlacklistCmd ? 'add' : 'remove';
            } else {
                // 手打ちコマンドからの抽出
                const cmdMatch = body.match(/\/(?:blacklist|reblacklist)\s+([0-9]+)/);
                if (cmdMatch) {
                    targetAid = cmdMatch[1];
                    commandType = isBlacklistCmd ? 'add' : 'remove';
                } else if (isReblacklistCmd) {
                    return res.status(200).send('No AID');
                }
            }

            // 実行
            if (commandType === 'add' && targetAid) {
                await supabase.from('blacklist').upsert({ account_id: targetAid });
                await updateRoomMembers(roomId, [targetAid]); // キック
                await sendMessage(roomId, `[info]対象者(ID: ${targetAid})をブラックリストに登録し、部屋から強制追放しました。[/info]`);
            } 
            else if (commandType === 'remove' && targetAid) {
                await supabase.from('blacklist').delete().eq('account_id', targetAid);
                await sendMessage(roomId, `[info]対象者(ID: ${targetAid})をブラックリストから解除しました。[/info]`);
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

// --- 自動パトロール機能（10秒に1回） ---
setInterval(async () => {
    if (!TARGET_ROOM_ID) return;
    try {
        const { data: members } = await cw.get(`/rooms/${TARGET_ROOM_ID}/members`);
        const { data: blacklist } = await supabase.from('blacklist').select('account_id');
        if (!members || !blacklist || blacklist.length === 0) return;

        const blacklistedIds = blacklist.map(b => b.account_id);
        
        // 部屋にいるメンバーの中にブラックリストのIDがないか照合
        const toKick = members
            .filter(m => blacklistedIds.includes(m.account_id.toString()))
            .map(m => m.account_id.toString());
        
        if (toKick.length > 0) {
            await updateRoomMembers(TARGET_ROOM_ID, toKick); // 即座にキック
            await sendMessage(TARGET_ROOM_ID, `[info]【システム】\nブラックリスト対象者 (${toKick.join(', ')}) の侵入を検知したため、即座に追放しました。入ってくんなハゲ[/info]`);
        }
    } catch (e) {
        // エラーは無視してパトロール継続
    }
}, 1000);

app.get('/', (req, res) => res.send('Bot is Live - V4 (Patrol Active)'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));
