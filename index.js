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

// スパム（連投）監視用データ
const spamRecords = {};
// ブラックジャック状態管理
const bjState = {};

const initBot = async () => {
    try {
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

// 連投チェック関数（5秒以内に5回でクロ）
const checkSpam = (accountId) => {
    const now = Date.now();
    if (!spamRecords[accountId]) spamRecords[accountId] = [];
    spamRecords[accountId].push(now);
    spamRecords[accountId] = spamRecords[accountId].filter(t => now - t <= 5000);
    if (spamRecords[accountId].length >= 5) {
        spamRecords[accountId] = []; // リセットして罰へ
        return true;
    }
    return false;
};

// --- 防衛・権限変更処理 ---
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
            
            // action が 'readonly' なら閲覧のみリストに突っ込む
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

// --- ブラックジャック用 関数 ---
const createDeck = () => {
    const suits = ['♠', '♥', '♣', '♦'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = [];
    for (let s of suits) {
        for (let r of ranks) {
            let val = (r === 'A') ? 1 : (['J', 'Q', 'K'].includes(r) ? 10 : parseInt(r));
            deck.push({ suit: s, rank: r, val: val });
        }
    }
    for(let i = deck.length - 1; i > 0; i--){
        const r = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[r]] = [deck[r], deck[i]];
    }
    return deck;
};

const calcScore = (hand) => {
    let score = 0, aces = 0;
    for (let c of hand) {
        if (c.rank === 'A') { aces++; score += 11; } 
        else score += c.val;
    }
    while (score > 21 && aces > 0) { score -= 10; aces--; }
    return score;
};

const nextBJTurn = async (roomId, bj) => {
    while (bj.turnIndex < bj.players.length) {
        let p = bj.players[bj.turnIndex];
        if (p.status !== 'playing') {
            bj.turnIndex++;
            continue;
        }
        let score = calcScore(p.hand);
        let handStr = p.hand.map(c => c.suit + c.rank).join(' ');
        await sendMessage(roomId, `[info][title]ターンの回番[/title][piconname:${p.aid}] さんの番です！\n手札: ${handStr} (スコア: ${score})\n引く場合は /hit 、引かない場合は /stand を入力してください。[/info]`);
        return;
    }
    await dealerTurn(roomId, bj);
};

const dealerTurn = async (roomId, bj) => {
    let msg = `[info][title]🃏 結果発表[/title]【ディーラー】\n伏せカードは ${bj.dealerHand[1].suit}${bj.dealerHand[1].rank} でした。\n`;
    let score = calcScore(bj.dealerHand);
    
    while(score < 17) {
        bj.dealerHand.push(bj.deck.pop());
        score = calcScore(bj.dealerHand);
    }
    let dHandStr = bj.dealerHand.map(c => c.suit + c.rank).join(' ');
    msg += `最終手札: ${dHandStr} (スコア: ${score})\n`;
    if (score > 21) msg += `💥 ディーラーバースト！\n`;
    
    msg += `\n【プレイヤー結果】\n`;
    for (let p of bj.players) {
        let pScore = calcScore(p.hand);
        let result = '', winAmount = 0;
        
        if (p.status === 'bust') {
            result = '負け (バースト)';
        } else if (p.status === 'bj') {
            if (score === 21 && bj.dealerHand.length === 2) { result = '引き分け'; winAmount = p.bet; } 
            else { result = '勝ち！ (BJ: 配当2.5倍)'; winAmount = Math.floor(p.bet * 2.5); }
        } else {
            if (score > 21 || pScore > score) { result = '勝ち！ (配当2倍)'; winAmount = p.bet * 2; } 
            else if (pScore === score) { result = '引き分け (返金)'; winAmount = p.bet; } 
            else { result = '負け'; }
        }
        
        if (winAmount > 0) {
            const { data } = await supabase.from('players').select('money').eq('account_id', p.aid).single();
            if (data) await supabase.from('players').update({ money: data.money + winAmount }).eq('account_id', p.aid);
        }
        msg += `[piconname:${p.aid}]: ${pScore} ➡ ${result} ${winAmount > 0 ? `(+${winAmount}コイン)` : ''}\n`;
    }
    msg += `[/info]`;
    await sendMessage(roomId, msg);
    bj.state = 'IDLE'; // 初期化
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
            // --- ブラックリスト本人のキック ---
            const { data: isBlacklisted } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId);
            if (isBlacklisted && isBlacklisted.length > 0) {
                await updateRoomMembers(roomId, [senderId], 'kick'); 
                await deleteMessage(roomId, messageId); 
                return;
            }

            runPatrol(roomId);

            // --- スパム（連投）検知 ---
            if (checkSpam(senderId)) {
                await updateRoomMembers(roomId, [senderId], 'readonly');
                await sendMessage(roomId, `[info]⚠️ [piconname:${senderId}] 連投（スパム）を検知したため、権限を「閲覧のみ」に制限しました。[/info]`);
                return;
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

            // --- 新型スロット (/slot 100) ---
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

            // --- 超本格ブラックジャック (BJ) ---
            if (!bjState[roomId]) bjState[roomId] = { state: 'IDLE', host: null, players: [], deck: [], dealerHand: [], turnIndex: 0 };
            let bj = bjState[roomId];

            if (body.trim() === '/bj' && gambleActive) {
                if (bj.state !== 'IDLE') return;
                bj.state = 'RECRUITING';
                bj.host = senderId;
                bj.players = [{ aid: senderId, bet: 0, hand: [], status: 'waiting' }];
                await sendMessage(roomId, `[info][title]🃏 ブラックジャック募集開始[/title]ブラックジャックを開始しました！\n参加者は /join bj と入力してください。(現在 1/4人)\nホスト([piconname:${senderId}])は /startbj で強制開始できます。[/info]`);
                return;
            }

            if (body.trim() === '/join bj' && gambleActive) {
                if (bj.state !== 'RECRUITING') return;
                if (bj.players.find(p => p.aid === senderId)) return;
                bj.players.push({ aid: senderId, bet: 0, hand: [], status: 'waiting' });
                
                let msg = `[info][piconname:${senderId}] がBJに参加しました！ (現在 ${bj.players.length}/4人)[/info]`;
                if (bj.players.length >= 4) {
                    bj.state = 'BETTING';
                    msg += `\n[info][title]ベット受付開始[/title]4人集まりました！\n参加者は /bet 掛け金 でベットしてください。[/info]`;
                }
                await sendMessage(roomId, msg);
                return;
            }

            if (body.trim() === '/startbj' && gambleActive) {
                if (bj.state !== 'RECRUITING' || bj.host !== senderId) return;
                bj.state = 'BETTING';
                await sendMessage(roomId, `[info][title]ベット受付開始[/title]ホストが強制開始しました！\n参加者は /bet 掛け金 でベットしてください。[/info]`);
                return;
            }

            const betMatch = body.match(/(^|\n)\/bet\s+([0-9]+)/);
            if (betMatch && gambleActive) {
                if (bj.state !== 'BETTING') return;
                let p = bj.players.find(p => p.aid === senderId);
                if (!p || p.bet > 0) return; 
                
                let betAmount = parseInt(betMatch[2], 10);
                if (betAmount <= 0) return;
                
                const { data } = await supabase.from('players').select('money').eq('account_id', senderId).single();
                if (!data || data.money < betAmount) return await sendMessage(roomId, `[rp aid=${senderId}] お金が足りません！`);
                
                await supabase.from('players').update({ money: data.money - betAmount }).eq('account_id', senderId);
                p.bet = betAmount;
                await sendMessage(roomId, `[piconname:${senderId}] が ${betAmount} コインをベットしました！`);
                
                if (bj.players.every(p => p.bet > 0)) {
                    bj.state = 'PLAYING';
                    bj.deck = createDeck();
                    bj.dealerHand = [bj.deck.pop(), bj.deck.pop()];
                    
                    let msg = `[info][title]🃏 ブラックジャック開始！[/title]ディーラー: ${bj.dealerHand[0].suit}${bj.dealerHand[0].rank} / [裏]\n\n`;
                    for (let player of bj.players) {
                        player.hand = [bj.deck.pop(), bj.deck.pop()];
                        let pScore = calcScore(player.hand);
                        let handStr = player.hand.map(c => c.suit + c.rank).join(' ');
                        msg += `[piconname:${player.aid}]: ${handStr} (スコア: ${pScore})`;
                        if (pScore === 21) { player.status = 'bj'; msg += ` 🎉 ブラックジャック！\n`; } 
                        else { player.status = 'playing'; msg += `\n`; }
                    }
                    msg += `[/info]`;
                    await sendMessage(roomId, msg);
                    bj.turnIndex = 0;
                    await nextBJTurn(roomId, bj);
                }
                return;
            }

            if (body.trim() === '/hit' && gambleActive) {
                if (bj.state !== 'PLAYING') return;
                let p = bj.players[bj.turnIndex];
                if (p.aid !== senderId) return;
                
                p.hand.push(bj.deck.pop());
                let score = calcScore(p.hand);
                let handStr = p.hand.map(c => c.suit + c.rank).join(' ');
                
                if (score > 21) {
                    p.status = 'bust';
                    await sendMessage(roomId, `[info][piconname:${p.aid}] 手札: ${handStr} (スコア: ${score})\n💥 バーストしました！[/info]`);
                    bj.turnIndex++; await nextBJTurn(roomId, bj);
                } else if (score === 21) {
                    p.status = 'stand';
                    await sendMessage(roomId, `[info][piconname:${p.aid}] 手札: ${handStr} (スコア: ${score})\n✨ 21到達！自動スタンドします。[/info]`);
                    bj.turnIndex++; await nextBJTurn(roomId, bj);
                } else {
                    await sendMessage(roomId, `[info][piconname:${p.aid}] 手札: ${handStr} (スコア: ${score})\n/hit または /stand[/info]`);
                }
                return;
            }

            if (body.trim() === '/stand' && gambleActive) {
                if (bj.state !== 'PLAYING') return;
                let p = bj.players[bj.turnIndex];
                if (p.aid !== senderId) return;
                
                p.status = 'stand';
                let score = calcScore(p.hand);
                let handStr = p.hand.map(c => c.suit + c.rank).join(' ');
                await sendMessage(roomId, `[info][piconname:${p.aid}] スタンドしました。 手札: ${handStr} (スコア: ${score})[/info]`);
                
                bj.turnIndex++;
                await nextBJTurn(roomId, bj);
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

app.get('/', (req, res) => res.send('Bot is Live - V14 (Casino Edition)'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));
