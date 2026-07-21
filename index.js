const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- API Client Init ---
const chatworkClient = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- Global States ---
let gambleActive = false;
let localLastResetDate = null;
const spamRecords = {};
const gameState = {}; // 全ゲームの進行状況管理

// 起動時にギャンブル状態を取得
supabase.from('config').select('value').eq('key', 'gamble_active').single().then(r => {
    if (r.data) gambleActive = r.data.value === 'true';
}).catch(()=>{});

// --- Date & Formatting Utils ---
const getTodayStr = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getThisMonthStr = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const formatNumber = (n) => Number(n).toLocaleString();

const verifySignature = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    if (!sig || !req.rawBody) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return sig === expected;
};

// --- Chatwork Messages ---
const makeReplyTag = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;

const sendMessage = async (roomId, text) => {
    try { await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`); } catch(e){}
};

const sendTempMessage = async (roomId, text, ms = 60000) => {
    try {
        const res = await chatworkClient.post(`/rooms/${roomId}/messages`, `body=${encodeURIComponent(text)}`);
        if (res && res.data && res.data.message_id) {
            setTimeout(() => chatworkClient.delete(`/rooms/${roomId}/messages/${res.data.message_id}`).catch(()=>{}), ms);
        }
    } catch(e) {}
};

// --- お金・借金管理 (自動返済機能) ---
const addMoneyWithRepay = async (accountId, amount) => {
    const { data: player } = await supabase.from('players').select('*').eq('account_id', accountId).single();
    let money = player ? player.money : 0;
    let debt = player ? (player.debt || 0) : 0;

    if (debt > 0 && amount > 0) {
        let repayAmount = Math.min(debt, amount);
        debt -= repayAmount;
        amount -= repayAmount;
    }
    money += amount;

    if (player) {
        await supabase.from('players').update({ money: money, debt: debt }).eq('account_id', accountId);
    } else {
        await supabase.from('players').insert({ account_id: accountId, money: money, debt: debt, slot_count: 0, work_limit: 5, msg_count: 0, job: 'サラリーマン' });
    }
};

// --- 管理・防衛機能 ---
const isUserAdmin = async (roomId, accountId) => {
    try {
        const { data: members } = await chatworkClient.get(`/rooms/${roomId}/members`);
        const member = members.find(x => x.account_id.toString() === accountId.toString());
        return member && (member.role === 'admin' || member.role === 'creator');
    } catch(e) { return false; }
};

const updateRoomMembers = async (roomId, targetAids, action = 'readonly') => {
    try {
        const { data: membersList } = await chatworkClient.get(`/rooms/${roomId}/members`);
        let admins = membersList.filter(m => m.role === 'admin' || m.role === 'creator').map(m => m.account_id.toString());
        let members = membersList.filter(m => m.role === 'member').map(m => m.account_id.toString());
        let readonlys = membersList.filter(m => m.role === 'readonly').map(m => m.account_id.toString());
        let found = false;

        for (const aid of targetAids) {
            let id = aid.toString();
            if (admins.includes(id) || members.includes(id) || readonlys.includes(id)) found = true;
            admins = admins.filter(x => x !== id);
            members = members.filter(x => x !== id);
            readonlys = readonlys.filter(x => x !== id);
            if (action === 'readonly') readonlys.push(id);
        }
        if (!found) return;

        const params = new URLSearchParams();
        if (admins.length > 0) params.append('members_admin_ids', admins.join(','));
        if (members.length > 0) params.append('members_member_ids', members.join(','));
        if (readonlys.length > 0) params.append('members_readonly_ids', readonlys.join(','));
        await chatworkClient.put(`/rooms/${roomId}/members`, params.toString());
    } catch(e) {}
};

const checkSpam = (accountId) => {
    const now = Date.now();
    if (!spamRecords[accountId]) spamRecords[accountId] = [];
    spamRecords[accountId].push(now);
    spamRecords[accountId] = spamRecords[accountId].filter(time => now - time <= 5000);
    return (spamRecords[accountId].length >= 10);
};

// --- ゲームエンジン ---

// 競馬（ダービー）生成
const generateDerby = () => {
    let stats = []; 
    for(let i=0; i<6; i++) stats.push(Math.random() * 10 + 1);
    
    let combos = [], totalWeight = 0;
    let oddsMap = {}, oddsStr = "";
    
    for(let i=1; i<=5; i++){
        for(let j=i+1; j<=6; j++){
            let weight = stats[i-1] * stats[j-1];
            combos.push({ combo: `${i}-${j}`, weight: weight });
            totalWeight += weight;
        }
    }
    
    combos.forEach(c => {
        let odd = (0.8 / (c.weight / totalWeight)).toFixed(1);
        if (odd < 1.1) odd = 1.1; 
        if (odd > 150) odd = 150.0;
        oddsMap[c.combo] = Number(odd);
    });
    
    Object.keys(oddsMap).sort((a,b) => oddsMap[a] - oddsMap[b]).forEach(k => {
        oddsStr += `🐎 ${k} : [code]${oddsMap[k]}倍[/code]\n`;
    });
    
    return { oddsMap, oddsStr, stats };
};

// チンチロリン生成
const generateChinchiroRoll = () => {
    for (let i = 0; i < 3; i++) {
        let dice = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1].sort((a,b)=>a-b);
        if (dice[0] === 1 && dice[1] === 1 && dice[2] === 1) return { dice, name: "ピンゾロ", rank: 6, score: 1, mult: 5 };
        if (dice[0] === dice[1] && dice[1] === dice[2]) return { dice, name: `${dice[0]}の嵐`, rank: 5, score: dice[0], mult: 3 };
        if (dice[0] === 4 && dice[1] === 5 && dice[2] === 6) return { dice, name: "シゴロ", rank: 4, score: 6, mult: 2 };
        if (dice[0] === 1 && dice[1] === 2 && dice[2] === 3) return { dice, name: "ヒフミ", rank: 0, score: 0, mult: -2 };
        if (dice[0] === dice[1]) return { dice, name: `${dice[2]}の目`, rank: 2, score: dice[2], mult: 1 };
        if (dice[1] === dice[2]) return { dice, name: `${dice[0]}の目`, rank: 2, score: dice[0], mult: 1 };
        if (dice[0] === dice[2]) return { dice, name: `${dice[1]}の目`, rank: 2, score: dice[1], mult: 1 };
    }
    return { dice: [0,0,0], name: "目なし", rank: 1, score: 0, mult: 1 };
};

// ヨット手役評価
const evaluateYacht = (dice) => {
    let counts = {};
    dice.forEach(d => counts[d] = (counts[d] || 0) + 1);
    let values = Object.values(counts).sort((a, b) => b - a);
    let uniqueDice = [...new Set(dice)].sort((a, b) => a - b);
    let strStr = uniqueDice.join('');
    
    if (values[0] === 5) return { name: "ヨット (5カード)", mult: 25 };
    if (strStr.includes('12345') || strStr.includes('23456')) return { name: "ビッグストレート", mult: 8 };
    if (values[0] === 4) return { name: "フォーダイス", mult: 4 };
    if (values[0] === 3 && values[1] === 2) return { name: "フルハウス", mult: 2 };
    if (strStr.includes('1234') || strStr.includes('2345') || strStr.includes('3456')) return { name: "スモールストレート", mult: 1 };
    
    return { name: "役なし", mult: 0 };
};

// トランプ生成
const generateDeck = () => {
    const suits = ['♠', '♥', '♣', '♦'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = [];
    for (let suit of suits) {
        for (let rank of ranks) {
            let value = (rank === 'A') ? 1 : (['J', 'Q', 'K'].includes(rank) ? 10 : parseInt(rank));
            deck.push({ suit, rank, value });
        }
    }
    for(let i = deck.length - 1; i > 0; i--) {
        const rand = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[rand]] = [deck[rand], deck[i]];
    }
    return deck;
};

const calculateBJScore = (hand) => {
    let score = 0, aces = 0;
    for (let card of hand) {
        if (card.rank === 'A') { aces++; score += 11; } 
        else { score += card.value; }
    }
    while (score > 21 && aces > 0) { score -= 10; aces--; }
    return score;
};

// ポーカーの手札評価
const evaluatePokerHand = (hand) => {
    const rankCounts = {};
    const suitsCount = {};
    const values = [];

    hand.forEach(card => {
        let v;
        if (card.rank === 'A') v = 14;
        else if (card.rank === 'J') v = 11;
        else if (card.rank === 'Q') v = 12;
        else if (card.rank === 'K') v = 13;
        else v = parseInt(card.rank);
        
        values.push(v);
        rankCounts[v] = (rankCounts[v] || 0) + 1;
        suitsCount[card.suit] = (suitsCount[card.suit] || 0) + 1;
    });

    values.sort((a, b) => b - a);
    const isFlush = Object.keys(suitsCount).length === 1;
    
    let isStraight = true;
    for (let i = 0; i < 4; i++) {
        if (values[i] - 1 !== values[i+1]) {
            isStraight = false;
            break;
        }
    }
    if (!isStraight && values[0] === 14 && values[1] === 5 && values[2] === 4 && values[3] === 3 && values[4] === 2) {
        isStraight = true;
    }

    const counts = Object.values(rankCounts).sort((a, b) => b - a);
    
    if (isFlush && isStraight) {
        if (values[0] === 14 && values[1] === 13) return { name: "ロイヤルストレートフラッシュ", mult: 100 };
        return { name: "ストレートフラッシュ", mult: 50 };
    }
    if (counts[0] === 4) return { name: "フォーカード", mult: 20 };
    if (counts[0] === 3 && counts[1] === 2) return { name: "フルハウス", mult: 10 };
    if (isFlush) return { name: "フラッシュ", mult: 7 };
    if (isStraight) return { name: "ストレート", mult: 5 };
    if (counts[0] === 3) return { name: "スリーカード", mult: 3 };
    if (counts[0] === 2 && counts[1] === 2) return { name: "ツーペア", mult: 2 };
    if (counts[0] === 2) {
        const pairRank = parseInt(Object.keys(rankCounts).find(key => rankCounts[key] === 2));
        if (pairRank >= 11 || pairRank === 14) return { name: "ワンペア (J以上)", mult: 1 };
        return { name: "ワンペア", mult: 0 };
    }
    return { name: "ノーペア", mult: 0 };
};


// --- ゲーム進行・タイマー ---
const startGameTimer = (roomId, ms = 60000, isDerby = false) => {
    let game = gameState[roomId]; 
    if (!game) return;
    
    if (game.timeoutId) clearTimeout(game.timeoutId);
    if (game.remindId) clearTimeout(game.remindId);
    
    if (isDerby) {
        game.remindId = setTimeout(() => {
            if (gameState[roomId] && gameState[roomId].state === 'BETTING') {
                sendTempMessage(roomId, `[info]⏳ 競馬のベット締め切りまで【残り1分】です！\nまだの方は [code]/bet [額] [馬番-馬番][/code] を入力してください。[/info]`);
            }
        }, ms - 60000);
    }
    game.timeoutId = setTimeout(() => handleGameTimeout(roomId), ms);
};

const handleGameTimeout = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.state === 'IDLE') return;

    if (game.state === 'RECRUITING') {
        let isEnoughPlayers = ['bj', 'poker', 'yacht', 'cc', 'sicbo'].includes(game.type) ? (game.players.length >= 1) : (game.players.length >= 2);
        
        if (isEnoughPlayers) {
            game.state = 'BETTING';
            if (game.type === 'derby') {
                let ex = `\n【 🐎 馬連オッズ 】\n${game.oddsStr}\n[hr]👉 [code]/bet [額] [馬1]-[馬2][/code] (例: /bet 100 1-2)`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${ex}\n[hr](※制限2分。残り1分でリマインドします)[/info]`, 120000);
                startGameTimer(roomId, 120000, true);
            } else if (game.type === 'sicbo') {
                let ex = `👉 [code]/bet [額] dai/shou/any[/code] でベットしてください。`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。 /bet max や /bet half も使えます)[/info]`);
                startGameTimer(roomId, 60000);
            } else {
                let ex = `👉 [code]/bet [額][/code] でベットしてください。`;
                await sendTempMessage(roomId, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。 /bet max や /bet half も使えます)[/info]`);
                startGameTimer(roomId, 60000);
            }
        } else {
            await sendTempMessage(roomId, `[info][title]⚠️ ゲーム中止[/title]参加者が規定人数未満のため、ゲームを中止します。[/info]`);
            gameState[roomId] = null;
        }
    } else if (game.state === 'BETTING') {
        let kickedAids = [], activePlayers = [];
        for (let player of game.players) {
            if (player.bet === 0) {
                kickedAids.push(player.aid);
            } else {
                activePlayers.push(player);
            }
        }
        game.players = activePlayers;
        
        if (kickedAids.length > 0) {
            await sendTempMessage(roomId, `[info][title]⏳ タイムアウト[/title]時間切れのため、未ベットのプレイヤーを退出させました。\n${kickedAids.map(a => `[piconname:${a}]`).join(' ')}[/info]`);
        }
        
        let isEnoughPlayers = ['bj', 'poker', 'yacht', 'cc', 'sicbo'].includes(game.type) ? (game.players.length >= 1) : (game.players.length >= 2);
        
        if (!isEnoughPlayers) {
            for (let player of game.players) {
                if (player.bet > 0) await addMoneyWithRepay(player.aid, player.bet);
            }
            await sendTempMessage(roomId, `[info][title]⚠️ ゲーム中止[/title]残りの参加者が規定人数未満になったため中止し、全額返金しました。[/info]`);
            gameState[roomId] = null;
        } else {
            await checkGameProgress(roomId);
        }
    } else if (game.state === 'ACTION') {
        if (game.type === 'bj' || game.type === 'poker' || game.type === 'yacht') {
            let player = game.players[game.turnIndex];
            if (player && player.status === 'playing') {
                player.status = 'stand';
                await sendTempMessage(roomId, `[info]⏳ タイムアウトにより、[piconname:${player.aid}] 様は自動スタンドしました。[/info]`);
                game.turnIndex++;
                if (game.type === 'poker') await proceedNextPokerTurn(roomId);
                else if (game.type === 'yacht') await proceedNextYachtTurn(roomId);
                else await proceedNextBJTurn(roomId);
            }
        } else {
            let kickedAids = [], activePlayers = [];
            for (let player of game.players) {
                let isKicked = false;
                if (game.type === 'chouhan' && !player.choice) isKicked = true;
                if (game.type === 'cc' && !player.res) isKicked = true; // ボット親なので全員対象
                
                if (isKicked) {
                    kickedAids.push(player.aid);
                    if (player.bet > 0) await addMoneyWithRepay(player.aid, player.bet);
                } else {
                    activePlayers.push(player);
                }
            }
            game.players = activePlayers;
            
            if (kickedAids.length > 0) {
                await sendTempMessage(roomId, `[info][title]⏳ タイムアウト[/title]時間切れのため未操作のプレイヤーを退出・返金しました。\n${kickedAids.map(a => `[piconname:${a}]`).join(' ')}[/info]`);
            }
            
            let isEnoughPlayers = ['cc'].includes(game.type) ? (game.players.length >= 1) : (game.players.length >= 2);
            if (!isEnoughPlayers) {
                for (let player of game.players) {
                    if (player.bet > 0) await addMoneyWithRepay(player.aid, player.bet);
                }
                await sendTempMessage(roomId, `[info][title]⚠️ ゲーム中止[/title]残りの参加者が規定人数未満になったため中止・返金しました。[/info]`);
                gameState[roomId] = null;
            } else {
                if (game.type === 'chouhan') await resolveChouhan(roomId);
                else if (game.type === 'cc') await resolveChinchiro(roomId);
            }
        }
    }
};

const checkGameProgress = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.state === 'IDLE') return;
    
    if (game.state === 'BETTING' && game.players.every(p => p.bet > 0)) {
        if (game.type === 'derby') {
            clearTimeout(game.timeoutId); if (game.remindId) clearTimeout(game.remindId);
            await resolveDerby(roomId);
        } else if (game.type === 'sicbo') {
            clearTimeout(game.timeoutId);
            await resolveSicbo(roomId);
        } else if (game.type === 'bj') {
            game.state = 'ACTION';
            game.deck = generateDeck();
            game.dealerHand = [game.deck.pop(), game.deck.pop()];
            
            let msg = `[info][title]🃏 ブラックジャック 開始[/title]全員ベット完了！カードを配ります。\n\n【 ディーラー 】\n🎴 ${game.dealerHand[0].suit}${game.dealerHand[0].rank} / [裏]\n[hr]【 プレイヤー 】\n`;
            for (let p of game.players) {
                p.hand = [game.deck.pop(), game.deck.pop()];
                let pScore = calculateBJScore(p.hand);
                let hStr = p.hand.map(c => c.suit + c.rank).join(' ');
                msg += `[piconname:${p.aid}]: ${hStr} (スコア: ${pScore})`;
                if (pScore === 21) { p.status = 'bj'; msg += ` 🎉 ブラックジャック！\n`; } 
                else { p.status = 'playing'; msg += `\n`; }
            }
            msg += `[/info]`;
            await sendTempMessage(roomId, msg, 120000);
            game.turnIndex = 0;
            await proceedNextBJTurn(roomId);
        } else if (game.type === 'poker') {
            game.state = 'ACTION';
            game.deck = generateDeck();
            
            let msg = `[info][title]🃏 ポーカー 開始[/title]全員ベット完了！5枚ずつカードを配ります。\n\n`;
            for (let p of game.players) {
                p.hand = [];
                for(let i=0; i<5; i++) p.hand.push(game.deck.pop());
                p.status = 'playing';
            }
            msg += `[/info]`;
            await sendTempMessage(roomId, msg, 120000);
            game.turnIndex = 0;
            await proceedNextPokerTurn(roomId);
        } else if (game.type === 'yacht') {
            game.state = 'ACTION';
            let msg = `[info][title]🎲 ヨット 開始[/title]全員ベット完了！サイコロを5個振ります。\n\n`;
            for (let p of game.players) {
                p.dice = [];
                for(let i=0; i<5; i++) p.dice.push(Math.floor(Math.random() * 6) + 1);
                p.status = 'playing';
                p.rolls = 1;
            }
            msg += `[/info]`;
            await sendTempMessage(roomId, msg, 120000);
            game.turnIndex = 0;
            await proceedNextYachtTurn(roomId);
        } else {
            game.state = 'ACTION';
            let txt = game.type === 'chouhan' ? "丁半を予想し、 [code]/chou[/code] (丁) または [code]/han[/code] (半) と発言してください。" : "各プレイヤーは [code]/roll[/code] でサイコロを振ってください。";
            await sendTempMessage(roomId, `[info][title]🎲 ゲーム進行[/title]全員のベットが完了しました！\n${txt}\n[hr](※制限時間: 1分)[/info]`);
            startGameTimer(roomId, 60000);
        }
    } else if (game.state === 'ACTION') {
        if (game.type === 'chouhan' && game.players.every(p => p.choice)) await resolveChouhan(roomId);
        if (game.type === 'cc' && game.players.every(p => p.res)) await resolveChinchiro(roomId);
    }
};

const proceedNextBJTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'bj') return;
    
    while (game.turnIndex < game.players.length) {
        let player = game.players[game.turnIndex];
        if (player.status !== 'playing') { game.turnIndex++; continue; }
        
        let score = calculateBJScore(player.hand);
        let handStr = player.hand.map(c => c.suit + c.rank).join(' ');
        await sendTempMessage(roomId, `[info][title]🃏 ターン進行[/title][piconname:${player.aid}] さんの番です！\n手札: ${handStr} (スコア: ${score})\n\n👉 [code]/hit[/code] (引く) または [code]/stand[/code] (引かない) を入力してください。\n(制限1分)[/info]`);
        startGameTimer(roomId, 60000); 
        return;
    }
    await resolveBJ(roomId);
};

const proceedNextPokerTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'poker') return;
    
    while (game.turnIndex < game.players.length) {
        let player = game.players[game.turnIndex];
        if (player.status !== 'playing') { game.turnIndex++; continue; }
        
        let handStr = player.hand.map((c, i) => `[${i+1}] ${c.suit}${c.rank}`).join('   ');
        let ev = evaluatePokerHand(player.hand);
        
        await sendTempMessage(roomId, `[info][title]🃏 ポーカー ターン進行[/title][piconname:${player.aid}] さんの番です！\n手札:\n${handStr}\n(現状の役: ${ev.name})\n\n👉 交換するカードの番号をスペース区切りで指定してください。交換しない場合は [code]/stand[/code]\n例: [code]/change 1 3 5[/code]\n(制限1分)[/info]`);
        startGameTimer(roomId, 60000); 
        return;
    }
    await resolvePoker(roomId);
};

const proceedNextYachtTurn = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game || game.type !== 'yacht') return;
    
    while (game.turnIndex < game.players.length) {
        let player = game.players[game.turnIndex];
        if (player.status !== 'playing') { game.turnIndex++; continue; }
        
        let diceStr = player.dice.map((d, i) => `[${i+1}] 🎲${d}`).join('   ');
        let ev = evaluateYacht(player.dice);
        
        await sendTempMessage(roomId, `[info][title]🎲 ヨット ターン進行 ( ${player.rolls}/3 回目 )[/title][piconname:${player.aid}] さんの番です！\nサイコロ:\n${diceStr}\n(現状の役: ${ev.name})\n\n👉 振り直すサイコロの番号をスペース区切りで指定してください。振り直さない場合は [code]/stand[/code]\n例: [code]/change 1 3 5[/code]\n(制限1分)[/info]`);
        startGameTimer(roomId, 60000); 
        return;
    }
    await resolveYacht(roomId);
};

// --- ゲーム結果精算 ---
const resolveBJ = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let dHand = game.dealerHand;
    let dScore = calculateBJScore(dHand);
    let msg = `[info][title]🃏 ブラックジャック 結果発表[/title]【 ディーラーのターン 】\n伏せカードは ${dHand[1].suit}${dHand[1].rank} でした。\n`;
    
    while (dScore < 17) {
        let c = game.deck.pop(); 
        dHand.push(c); 
        dScore = calculateBJScore(dHand);
        msg += `➡ 引いたカード: ${c.suit}${c.rank}\n`;
    }
    
    let dStr = dHand.map(c => c.suit + c.rank).join(' ');
    msg += `最終手札: ${dStr} (スコア: ${dScore})\n`;
    if (dScore > 21) msg += `💥 ディーラーバースト！\n`;
    msg += `[hr]【 プレイヤー結果 】\n`;
    
    for (let player of game.players) {
        let pScore = calculateBJScore(player.hand);
        let winAmt = 0; let resTxt = "";
        
        if (player.status === 'bust') { 
            resTxt = `💀 負け (バースト)`; 
        } else if (player.status === 'bj') {
            if (dScore === 21 && dHand.length === 2) { 
                resTxt = `😐 引き分け (BJ同士)`; 
                await addMoneyWithRepay(player.aid, player.bet); 
            } else { 
                winAmt = Math.floor(player.bet * 2.5); 
                resTxt = `(cracker) 勝利！ (BJ: 配当2.5倍) (+${formatNumber(winAmt)})`; 
                await addMoneyWithRepay(player.aid, player.bet + winAmt); 
            }
        } else {
            if (dScore > 21 || pScore > dScore) { 
                winAmt = player.bet * 2; 
                resTxt = `🎉 勝利！ (+${formatNumber(winAmt)})`; 
                await addMoneyWithRepay(player.aid, player.bet + winAmt); 
            } 
            else if (pScore === dScore) { 
                resTxt = `😐 引き分け (返金)`; 
                await addMoneyWithRepay(player.aid, player.bet); 
            } 
            else { 
                resTxt = `💀 負け`; 
            }
        }
        msg += `[piconname:${player.aid}]: スコア ${pScore} ➡ ${resTxt}\n`;
    }
    
    await sendMessage(roomId, msg + "[/info]");
    gameState[roomId] = null;
};

const resolvePoker = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let msg = `[info][title]🃏 ポーカー 結果発表[/title]【 プレイヤー結果 】\n`;
    
    for (let player of game.players) {
        let ev = evaluatePokerHand(player.hand);
        let handStr = player.hand.map(c => c.suit + c.rank).join(' ');
        let winAmt = Math.floor(player.bet * ev.mult);
        let resTxt = "";
        
        if (ev.mult > 1) { 
            resTxt = `(cracker) 勝利！ (${ev.name}: 配当${ev.mult}倍) (+${formatNumber(winAmt)})`; 
            await addMoneyWithRepay(player.aid, winAmt); 
        } else if (ev.mult === 1) {
            resTxt = `😐 引き分け (${ev.name}: 返金)`; 
            await addMoneyWithRepay(player.aid, player.bet); 
        } else {
            resTxt = `💀 負け (${ev.name})`; 
        }
        
        msg += `[piconname:${player.aid}]: ${handStr} ➡ ${resTxt}\n`;
    }
    
    await sendMessage(roomId, msg + "[/info]");
    gameState[roomId] = null;
};

const resolveYacht = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let msg = `[info][title]🎲 ヨット 結果発表[/title]【 プレイヤー結果 】\n`;
    
    for (let player of game.players) {
        let ev = evaluateYacht(player.dice);
        let diceStr = player.dice.map(d => `🎲${d}`).join('');
        let winAmt = Math.floor(player.bet * ev.mult);
        let resTxt = "";
        
        if (ev.mult > 1) { 
            resTxt = `(cracker) 勝利！ (${ev.name}: 配当${ev.mult}倍) (+${formatNumber(winAmt)})`; 
            await addMoneyWithRepay(player.aid, winAmt); 
        } else if (ev.mult === 1) {
            resTxt = `😐 引き分け (${ev.name}: 返金)`; 
            await addMoneyWithRepay(player.aid, player.bet); 
        } else {
            resTxt = `💀 負け (${ev.name})`; 
        }
        
        msg += `[piconname:${player.aid}]: [${diceStr}] ➡ ${resTxt}\n`;
    }
    
    await sendMessage(roomId, msg + "[/info]");
    gameState[roomId] = null;
};

const resolveChinchiro = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let parentRoll = generateChinchiroRoll(); 
    let msg = `[info][title]🎲 チンチロリン 結果発表[/title]【 ディーラー(親) の出目 】\n[ ${parentRoll.dice.join(', ')} ] ➡ 『 ${parentRoll.name} 』\n[hr]【 プレイヤー結果 】\n`;
    
    for (let player of game.players) {
        let r = player.res || { rank: 1, name: "欠席", mult: 1, score: 0, dice: [0,0,0] };
        let win = (r.rank > parentRoll.rank) || (r.rank === parentRoll.rank && r.score > parentRoll.score);
        let draw = (r.rank === parentRoll.rank && r.score === parentRoll.score);
        
        if (draw) { 
            await addMoneyWithRepay(player.aid, player.bet); 
            msg += `😐 [piconname:${player.aid}]: [${r.dice.join('')}] ${r.name} ➡ 引き分け (返金)\n`; 
        } else if (win) { 
            let mult = r.mult > 0 ? r.mult : 1; 
            let winAmt = player.bet * mult;
            await addMoneyWithRepay(player.aid, player.bet + winAmt); 
            msg += `(cracker) [piconname:${player.aid}]: [${r.dice.join('')}] ${r.name} ➡ 勝ち！ (+${formatNumber(winAmt)})\n`; 
        } else { 
            msg += `💀 [piconname:${player.aid}]: [${r.dice.join('')}] ${r.name} ➡ 負け...\n`; 
        }
    }
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const resolveChouhan = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let d1 = Math.floor(Math.random() * 6) + 1;
    let d2 = Math.floor(Math.random() * 6) + 1;
    let sum = d1 + d2;
    let result = (sum % 2 === 0) ? 'chou' : 'han';
    
    let msg = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1} と ${d2} (合計:${sum})\n➡ 『 ${result === 'chou' ? '丁(偶数)' : '半(奇数)'} 』\n[hr]【 プレイヤー結果 】\n`;
    
    for (let player of game.players) {
        if (player.choice === result) { 
            await addMoneyWithRepay(player.aid, player.bet * 2); 
            msg += `(cracker) [piconname:${player.aid}]: 的中！ (+${formatNumber(player.bet * 2)} コイン)\n`; 
        } else { 
            msg += `💀 [piconname:${player.aid}]: 予想[${player.choice === 'chou' ? '丁' : '半'}] ➡ はずれ...\n`; 
        }
    }
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const resolveDerby = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId); 
    if (game.remindId) clearTimeout(game.remindId);
    
    let stats = game.stats, ws = [...stats], totalW = ws.reduce((a, b) => a + b, 0);
    
    let r1 = Math.random() * totalW, s1 = 0, first = 1;
    for (let i=0; i<6; i++) { s1 += ws[i]; if(r1 <= s1){ first = i+1; break; } }
    
    ws[first-1] = 0; 
    totalW = ws.reduce((a, b) => a + b, 0);
    let r2 = Math.random() * totalW, s2 = 0, second = 1;
    for (let i=0; i<6; i++) { s2 += ws[i]; if(r2 <= s2){ second = i+1; break; } }
    
    let winCombo = first < second ? `${first}-${second}` : `${second}-${first}`;
    let odd = game.oddsMap[winCombo];
    
    let msg = `[info][title]🐎 ダービー レース結果[/title]各馬一斉にスタート！\n...\n第4コーナーを回って最後の直線！\n...\n\n先頭で駆け抜けたのは【 ${first} 】番と【 ${second} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${winCombo} 】 (${odd}倍)\n[hr]【 プレイヤー結果 】\n`;
    
    for (let player of game.players) {
        if (player.choice === winCombo) { 
            let winAmt = Math.floor(player.bet * odd); 
            await addMoneyWithRepay(player.aid, player.bet + winAmt); 
            msg += `(cracker) [piconname:${player.aid}]: 的中！ (+${formatNumber(winAmt)} コイン)\n`; 
        } else { 
            msg += `💀 [piconname:${player.aid}]: 予想[${player.choice}] ➡ はずれ...\n`; 
        }
    }
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};

const resolveSicbo = async (roomId) => {
    let game = gameState[roomId]; 
    if (!game) return; 
    clearTimeout(game.timeoutId);
    
    let d1 = Math.floor(Math.random() * 6) + 1;
    let d2 = Math.floor(Math.random() * 6) + 1;
    let d3 = Math.floor(Math.random() * 6) + 1;
    let sum = d1 + d2 + d3;
    let isTriple = d1 === d2 && d2 === d3;
    
    let resultType = isTriple ? "any" : (sum >= 11 && sum <= 17 ? "dai" : "shou");
    let resultName = isTriple ? "ゾロ目" : (resultType === "dai" ? "大" : "小");
    
    let msg = `[info][title]🎲 シックボー(大小) 結果発表[/title]出目: ${d1}, ${d2}, ${d3} (合計:${sum})\n➡ 『 ${resultName} 』\n[hr]【 プレイヤー結果 】\n`;
    
    for (let player of game.players) {
        if (player.choice === 'any' && isTriple) {
            let winAmt = Math.floor(player.bet * 15);
            await addMoneyWithRepay(player.aid, player.bet + winAmt);
            msg += `(cracker) [piconname:${player.aid}]: 予想[ゾロ目] ➡ 的中！ (15倍) (+${formatNumber(winAmt)})\n`;
        } else if ((player.choice === 'dai' || player.choice === 'shou') && player.choice === resultType && !isTriple) {
            let winAmt = Math.floor(player.bet * 1.8);
            await addMoneyWithRepay(player.aid, player.bet + winAmt);
            msg += `(cracker) [piconname:${player.aid}]: 予想[${player.choice === 'dai' ? '大' : '小'}] ➡ 的中！ (1.8倍) (+${formatNumber(winAmt)})\n`;
        } else {
            let choiceName = player.choice === 'any' ? "ゾロ目" : (player.choice === 'dai' ? "大" : "小");
            msg += `💀 [piconname:${player.aid}]: 予想[${choiceName}] ➡ はずれ...\n`;
        }
    }
    await sendMessage(roomId, msg + "[/info]"); 
    gameState[roomId] = null; 
};


// --- Webhook メイン処理 ---
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid Signature');
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event;
    if (!ev || req.body.webhook_event_type !== 'message_created') return;

    const roomId = ev.room_id;
    const body = ev.body || "";
    const senderId = ev.account_id.toString();
    const msgId = ev.message_id;
    
    const today = getTodayStr();
    const thisMonth = getThisMonthStr();

    (async () => {
        try {
            // --- 返信タグの解析 ---
            const rpMatch = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const repliedAid = rpMatch ? rpMatch[1] : null;

            // 1. ブラックリスト防衛
            const { data: isBanned } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId).single();
            if (isBanned) { 
                await updateRoomMembers(roomId, [senderId], 'readonly'); 
                await chatworkClient.delete(`/rooms/${roomId}/messages/${msgId}`).catch(()=>{}); 
                return; 
            }

            // 2. スパム（連投）防衛
            if (checkSpam(senderId) && !(await isUserAdmin(roomId, senderId))) {
                await updateRoomMembers(roomId, [senderId], 'readonly');
                return sendTempMessage(roomId, `[info][title]⚠️ 警告[/title][piconname:${senderId}] 様\n連投行為を検知したため、発言権限を「閲覧のみ」に制限しました。[/info]`);
            }

            // 3. 深夜0時リセット & 宝くじ抽選
            if (localLastResetDate !== today) {
                const { data: configDate } = await supabase.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!configDate || configDate.value !== today) {
                    await supabase.from('players').update({ slot_count: 0, work_limit: 5, work_date: null, skill_date: null, omikuji_date: null }).neq('account_id', '0');
                    await supabase.from('config').upsert({ key: 'last_reset_date', value: today });
                    localLastResetDate = today;
                    
                    let resetMsg = `[info][title]🔄 日付更新のお知らせ[/title]深夜0時を回りました。\nスロット回数、おみくじ、お仕事制限がリセットされました！\n[hr]`;
                    
                    const { data: tData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tickets = tData ? JSON.parse(tData.value) : [];
                    if (tickets.length > 0) {
                        let win = Math.floor(Math.random() * 9999) + 1;
                        resetMsg += `[title]🎯 宝くじ 抽選結果発表[/title]本日の当選番号は...【 ${win} 】です！\n[hr]`;
                        let payouts = {}; let winners = [];
                        
                        const checkPrize = (n, w) => {
                            if (n === w) return { p: 100000, name: '🥇 1等' };
                            let prev = w - 1 < 1 ? 9999 : w - 1; 
                            let next = w + 1 > 9999 ? 1 : w + 1;
                            if (n === prev || n === next) return { p: 25000, name: '🥈 前後賞' };
                            if (n % 1000 === w % 1000) return { p: 5000, name: '🥈 2等' }; 
                            if (n % 100 === w % 100) return { p: 1000, name: '🥉 3等' };    
                            if (n % 10 === w % 10) return { p: 500, name: '🏅 4等' };      
                            return null;
                        };
                        
                        for (let t of tickets) { 
                            let r = checkPrize(t.num, win); 
                            if (r) { winners.push({ a: t.aid, num: t.num, ...r }); payouts[t.aid] = (payouts[t.aid] || 0) + r.p; } 
                        }
                        
                        if (winners.length > 0) {
                            for (let aid in payouts) await addMoneyWithRepay(aid, payouts[aid]);
                            winners.sort((a,b) => b.p - a.p); 
                            for (let w of winners.slice(0, 20)) resetMsg += `(cracker) [piconname:${w.a}]: 予想[${w.num}] ➡ ${w.name} (+${formatNumber(w.p)} コイン)\n`;
                            if (winners.length > 20) resetMsg += `...他 ${winners.length - 20} 件の当選！\n`;
                        } else {
                            resetMsg += `本日の当選者はいませんでした。明日の挑戦をお待ちしています！\n`;
                        }
                        await supabase.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                    }
                    sendMessage(roomId, resetMsg + `[/info]`);
                }
            }

            // 4. プレイヤーデータの確実な取得と作成
            let { data: player } = await supabase.from('players').select('*').eq('account_id', senderId).single();
            
            if (!player) {
                player = { account_id: senderId, money: 0, debt: 0, slot_count: 0, work_limit: 5, msg_count: 1, job: 'サラリーマン' };
                await supabase.from('players').insert(player);
            } else if (gambleActive && !body.startsWith('/')) {
                let mc = (player.msg_count || 0) + 1; 
                let wl = player.work_limit || 5;
                if (mc >= (Math.floor(Math.random() * 21) + 30)) { mc = 0; if (wl < 10) wl++; }
                player.msg_count = mc; player.work_limit = wl;
                await supabase.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', senderId);
            }

            let myMoney = player ? player.money : 0;
            let myDebt = player ? (player.debt || 0) : 0;
            let myJob = player ? (player.job || 'サラリーマン') : 'サラリーマン';
            let currentMonthlyDebt = (player && player.debt_month === thisMonth) ? (player.monthly_debt || 0) : 0;

            // --- 📖 ヘルプコマンド ---
            if (body.trim() === '/help-gya') {
                const helpMsg = `[info][title]🎰 カジノ＆ライフ 総合案内 (V41 SicBo)[/title]
【 🏦 銀行・ステータス 】
・ [code]/status[/code] : 状態確認
・ [code]/give [金額][/code] : 相手に送金 (税金10%)
・ [code]/debt [金額][/code] : 借金 (月上限5000)
・ [code]/money-rank[/code] : 純資産ランキング

【 💼 職業・スキル 】
・ [code]/job[/code] : 転職と求人
・ [code]/work[/code] : 職業給料 (10分に1回, 1日5回上限)
・ [code]/catch[/code] または [code]/goal[/code] : 職業専用能力
・ [code]/omikuji[/code] : 1日1回おみくじ (スロット確率変動)

【 🎰 カジノ・宝くじ 】
・ [code]/slot [掛金|max|half][/code] : スロット (1日5回)
・ [code]/buy-lot [連番|バラ] [枚数][/code] : 宝くじ (最大1000枚)

【 🎲 テーブルゲーム 】
・ [code]/chouhan[/code] : 丁半ゲーム募集
・ [code]/sicbo[/code] : シックボー募集 ([code]/bet [額] [dai/shou/any][/code])
・ [code]/cc[/code] : チンチロリン募集 (参加者は [code]/roll[/code] でサイコロ)
・ [code]/derby[/code] : ダービー募集 ([code]/bet [額] [馬番-馬番][/code])
・ [code]/bj[/code] : ブラックジャック募集 ([code]/hit[/code] か [code]/stand[/code])
・ [code]/poker[/code] : ポーカー募集 ([code]/change [番号][/code] か [code]/stand[/code])
・ [code]/yacht[/code] : ヨット募集 ([code]/change [番号][/code] か [code]/stand[/code])

【 👑 管理者専用 】
・ [code]/take [金][/code], [code]/fi-game[/code], [code]/st-gya[/code], [code]/fi-gya[/code], [code]/blacklist[/code] 等[/info]`;
                return sendTempMessage(roomId, helpMsg, 120000);
            }

            // --- 👑 管理者コマンド ---
            if (/(^|\n)\/take\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
                let amt = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2] || (body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                let targetAid = repliedAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if (targetAid && amt > 0) { 
                    await addMoneyWithRepay(targetAid, amt); 
                    return sendTempMessage(roomId, `[info][title]👑 特別資金付与[/title]管理者が [piconname:${targetAid}] 様へ ${formatNumber(amt)} コインを付与しました。[/info]`); 
                }
            }

            if (/(^|\n)\/fi-game\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
                if (gameState[roomId] && gameState[roomId].state !== 'IDLE') {
                    for (let p of gameState[roomId].players) {
                        if (p.bet > 0) await addMoneyWithRepay(p.aid, p.bet);
                    }
                    clearTimeout(gameState[roomId].timeoutId);
                    if (gameState[roomId].remindId) clearTimeout(gameState[roomId].remindId);
                    gameState[roomId] = null;
                    return sendTempMessage(roomId, `[info][title]⚠️ ゲーム強制終了[/title]管理者によってゲームが強制終了されました。\n(※賭け金は全額返還されました)[/info]`);
                } else {
                    return sendTempMessage(roomId, `[info]⚠️ 進行中のゲームはありません。[/info]`);
                }
            }

            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body) && await isUserAdmin(roomId, senderId)) {
                let targetAid = repliedAid || (body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
                let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'remove' : 'add');
                if (!targetAid && cmd !== 'add') return; 
                if (!targetAid && cmd === 'add') cmd = 'list';

                if (cmd === 'rank') {
                    const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single();
                    let ex = eD ? JSON.parse(eD.value) : [];
                    if (ex.includes(targetAid)) { 
                        ex = ex.filter(i => i !== targetAid); 
                        sendTempMessage(roomId, `[info][title]設定完了[/title][piconname:${targetAid}] 様のランキング除外を解除しました。[/info]`); 
                    } else { 
                        ex.push(targetAid); 
                        sendTempMessage(roomId, `[info][title]設定完了[/title][piconname:${targetAid}] 様をランキングから除外しました。[/info]`); 
                    }
                    return await supabase.from('config').upsert({key:'rank_excluded', value:JSON.stringify(ex)});
                }
                
                if (cmd === 'add') { 
                    await supabase.from('blacklist').insert({account_id: targetAid}); 
                    await updateRoomMembers(roomId, [targetAid], 'readonly'); 
                    return sendTempMessage(roomId, `[info][title]🚫 追放完了[/title][piconname:${targetAid}] をブラックリストに登録し、権限を「閲覧のみ」に変更しました。[/info]`); 
                } else if (cmd === 'remove') { 
                    await supabase.from('blacklist').delete().eq('account_id', targetAid); 
                    return sendTempMessage(roomId, `[info][title]✅ 解除完了[/title][piconname:${targetAid}] の追放状態を解除しました。[/info]`); 
                } else if (cmd === 'list') { 
                    const { data: ls } = await supabase.from('blacklist').select('account_id'); 
                    const listStr = ls && ls.length ? ls.map(d => `[piconname:${d.account_id}]`).join('\n') : "登録なし";
                    return sendTempMessage(roomId, `[info][title]📜 ブラックリスト一覧[/title]${listStr}\n[hr]※1分後に自動消滅します[/info]`); 
                }
            }

            if (body.startsWith('/st-gya') && await isUserAdmin(roomId, senderId)) { 
                gambleActive = true; await supabase.from('config').upsert({key:'gamble_active', value:'true'}); 
                return sendMessage(roomId, `[info][title]🎰 カジノ＆ライフ[/title]システムが【 有効 】になりました！[/info]`); 
            }
            if (body.startsWith('/fi-gya') && await isUserAdmin(roomId, senderId)) { 
                gambleActive = false; await supabase.from('config').upsert({key:'gamble_active', value:'false'}); 
                return sendMessage(roomId, `[info][title]🚫 カジノ＆ライフ[/title]システムが【 停止 】しました。[/info]`); 
            }

            // --- ⛩️ おみくじ ---
            if (/(^|\n)\/omikuji\b/.test(body) && gambleActive) {
                if (player && player.omikuji_date === today) return sendTempMessage(roomId, `[info][title]⚠️ おみくじ[/title]${makeReplyTag(senderId, roomId, msgId)}\n本日のおみくじは既に引いています。\n(結果: ${player.omikuji_result})[/info]`);
                
                let r = Math.random() * 100, res = "", eff = "";
                if(r < 10) { res = "大吉"; eff = "(cracker) スロット確率が【大幅UP】！"; } 
                else if(r < 30) { res = "中吉"; eff = "(cracker) スロット確率が【少しUP】！"; } 
                else if(r < 60) { res = "小吉"; eff = "🎯 スロット確率は通常通りです。"; } 
                else if(r < 85) { res = "吉"; eff = "🎯 スロット確率は通常通りです。"; } 
                else if(r < 95) { res = "凶"; eff = "💧 スロット確率が【少しDOWN】..."; } 
                else { res = "大凶"; eff = "💀 スロット確率が【大幅DOWN】..."; }
                
                await supabase.from('players').update({ omikuji_date: today, omikuji_result: res }).eq('account_id', senderId);
                return sendMessage(roomId, `[info][title]⛩️ おみくじ結果[/title]${makeReplyTag(senderId, roomId, msgId)}\n[hr]今日の運勢は...【 ${res} 】です！\n\n${eff}[/info]`);
            }

            // --- 🏦 銀行関連 (借金・送金) ---
            const debtMatch = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (debtMatch && gambleActive) {
                let amt = parseInt(debtMatch[2], 10);
                if (amt > 0) {
                    if (currentMonthlyDebt + amt > 5000) return sendTempMessage(roomId, `[info][title]⚠️ 借金上限エラー[/title]${makeReplyTag(senderId, roomId, msgId)}\n1ヶ月の借金上限(5000)を超過します！\n(今月は既に ${currentMonthlyDebt} コイン借りています)[/info]`);
                    
                    await supabase.from('players').update({ money: myMoney + amt, debt: myDebt + amt, monthly_debt: currentMonthlyDebt + amt, debt_month: thisMonth }).eq('account_id', senderId);
                    return sendTempMessage(roomId, `[info][title]💳 お借り入れ完了[/title][piconname:${senderId}] 様\n${formatNumber(amt)} コインを借金しました。\n[hr]今月の借金可能枠: 残り ${formatNumber(5000 - (currentMonthlyDebt + amt))} コイン[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && gambleActive) {
                let targetAid = repliedAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let amt = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2] || (body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                
                if (targetAid && amt > 0) {
                    let av = Math.max(0, myMoney - myDebt); 
                    if (av < amt) return sendTempMessage(roomId, `[info][title]⚠️ 送金エラー[/title]${makeReplyTag(senderId, roomId, msgId)}\n送金枠(純資産)が不足しています！\n(借金があるため、送金可能額は ${formatNumber(av)} コインのみです)[/info]`);
                    
                    let tax = Math.floor(amt * 0.10); 
                    let rAmt = amt - tax;
                    
                    await supabase.from('players').update({ money: myMoney - amt }).eq('account_id', senderId);
                    
                    const { data: rc } = await supabase.from('players').select('*').eq('account_id', targetAid).single();
                    if (rc) await supabase.from('players').update({ money: rc.money + rAmt }).eq('account_id', targetAid);
                    else await supabase.from('players').insert({ account_id: targetAid, money: rAmt, debt: 0, slot_count: 0, work_limit: 5, msg_count: 0, job: 'サラリーマン' });
                    
                    return sendTempMessage(roomId, `[info][title]🎁 送金完了[/title][piconname:${senderId}] ➡ [piconname:${targetAid}]\n${formatNumber(amt)} コインを送金しました。\n[hr]※システム税 10% (${formatNumber(tax)} コイン) が引かれ、相手には ${formatNumber(rAmt)} コインが届きました。[/info]`);
                }
            }

            // --- 📊 ステータス & ランキング ---
            if (body.trim() === '/status') {
                const remSlot = Math.max(0, 5 - player.slot_count);
                const dStr = myDebt > 0 ? `\n💳 借金: -${formatNumber(myDebt)} コイン` : '';
                return sendTempMessage(roomId, `[info][title]📊 プレイヤー情報[/title][piconname:${senderId}] 様\n\n💰 所持金: ${formatNumber(myMoney)} コイン${dStr}\n💎 純資産: ${formatNumber(myMoney - myDebt)} コイン\n[hr]👔 職業: ${myJob}\n🎰 スロット残り: ${remSlot} 回\n💼 お仕事残り: ${player.work_limit} 回\n⛩️ 今日の運勢: ${player.omikuji_result || '未引'}\n[hr]※1分後に自動消去されます[/info]`);
            }

            if (body.trim() === '/money-rank') {
                const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single(); 
                let eI = eD ? JSON.parse(eD.value) : [];
                const { data: ls } = await supabase.from('players').select('*'); 
                let f = ls ? ls.filter(d => !eI.includes(d.account_id)) : [];
                
                f.sort((a,b) => ((b.money||0) - (b.debt||0)) - ((a.money||0) - (a.debt||0)));
                let s = f.slice(0, 10).map((d, i) => {
                    let net = (d.money||0) - (d.debt||0); 
                    let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                    return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰 純資産: ${formatNumber(net)} コイン ${d.debt>0 ? `(借金:-${formatNumber(d.debt)})`:''} [${d.job||'サラリーマン'}]`;
                }).join('\n[hr]');
                
                return sendTempMessage(roomId, `[info][title]👑 純資産ランキング TOP10[/title]${s}\n[hr]※5分後に自動消滅します[/info]`, 300000);
            }

            // --- 💼 職業機能 ---
            const cJobMatch = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (cJobMatch && gambleActive) {
                const jn = cJobMatch[2]; const cs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000};
                if (myJob === jn) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nすでに ${jn} に就いています！[/info]`);
                if (myMoney < cs[jn]) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nお金が足りません！(転職費用: ${formatNumber(cs[jn])} コイン)[/info]`);
                
                await supabase.from('players').update({ job: jn, money: myMoney - cs[jn] }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]🎉 転職完了[/title][piconname:${senderId}] 様\n本日より「${jn}」としてご活躍ください！ (-${formatNumber(cs[jn])} コイン)[/info]`);
            } else if (body.trim() === '/job' && gambleActive) {
                return sendTempMessage(roomId, `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 サラリーマン (費用: 0)
 ▶ [code]/work[/code] (100〜500) ※10%でミス0

🏛️ 公務員 (費用: 2000)
 ▶ [code]/work[/code] (300〜500)

🚓 警察官 (費用: 3000)
 ▶ [code]/work[/code] (300〜700)
 ▶ [code]/catch[/code] (30%の確率で犯人逮捕! 800)

⚽ プロスポーツ選手 (費用: 5000)
 ▶ [code]/work[/code] (500〜1000)
 ▶ [code]/goal[/code] (30%の確率でゴール! 1000)
[hr]※転職コマンド: [code]/job 役職名[/code][/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive) {
                if (player.work_limit <= 0) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n本日の仕事回数が上限(5回)に達しました。[/info]`);
                if (Date.now() - (player.last_work_time || 0) < 600000) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n休憩中です！仕事は10分間隔で行えます。[/info]`);
                
                let e = 0, m = "";
                if(myJob === 'サラリーマン'){ if(Math.random() < 0.1){ e=0; m="仕事で重大なミスをしてしまい、本日の給料は 0 コインに...😭"; } else { e=Math.floor(Math.random()*401)+100; m=`真面目に働き、 ${formatNumber(e)} コイン稼ぎました！💼`; } }
                else if(myJob === '公務員'){ e=Math.floor(Math.random()*201)+300; m=`安定した仕事をこなし、 ${formatNumber(e)} コイン稼ぎました！🏛️`; }
                else if(myJob === '警察官'){ e=Math.floor(Math.random()*401)+300; m=`街の平和を守り、 ${formatNumber(e)} コイン稼ぎました！🚓`; }
                else if(myJob === 'プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`試合で大活躍し、 ${formatNumber(e)} コイン稼ぎました！⚽`; }
                
                await supabase.from('players').update({ last_work_time: Date.now(), work_limit: player.work_limit - 1 }).eq('account_id', senderId);
                await addMoneyWithRepay(senderId, e); 
                return sendTempMessage(roomId, `[info][title]💼 お仕事完了[/title][piconname:${senderId}]\n${m}\n(残り ${player.work_limit - 1} 回)[/info]`);
            }

            if ((/(^|\n)\/catch\b/.test(body) || /(^|\n)\/goal\b/.test(body)) && gambleActive) {
                let iC = /(^|\n)\/catch\b/.test(body);
                if (iC && myJob !== '警察官') return sendTempMessage(roomId, `[info]⚠️ 警察官専用のコマンドです！[/info]`);
                if (!iC && myJob !== 'プロスポーツ選手') return sendTempMessage(roomId, `[info]⚠️ プロスポーツ選手専用のコマンドです！[/info]`);
                if (player.skill_date === today) return sendTempMessage(roomId, `[info]⚠️ 今日の特殊能力はすでに使用済みです！[/info]`);
                
                let sc = Math.random() < 0.3, e = 0, m = "";
                if (iC) { if(sc){ e=800; m=`見事犯人を逮捕しました！特別報酬 ${e} コイン獲得！🚨`; } else m=`犯人を逃してしまいました...🏃‍♂️💨`; }
                else { if(sc){ e=1000; m=`スーパーゴールを決めました！スポンサーから ${e} コイン獲得！🥅✨`; } else m=`シュートは外れてしまいました...🤦‍♂️`; }
                
                await supabase.from('players').update({ skill_date: today }).eq('account_id', senderId);
                await addMoneyWithRepay(senderId, e); 
                return sendTempMessage(roomId, `[info][title]✨ 特殊能力発動[/title][piconname:${senderId}]\n${m}[/info]`);
            }

            // --- 🎰 スロット ---
            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && gambleActive) {
                if (player.slot_count >= 5) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\n本日のスロットは上限(1日5回)に達しました！[/info]`);
                if (Date.now() - Number(player.last_slot_time || 0) < 600000) return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)}\nスロット休憩中(10分間隔)です！[/info]`);
                
                let bet = sM[2] === 'max' ? myMoney : (sM[2] === 'half' ? Math.floor(myMoney / 2) : parseInt(sM[2], 10));
                
                if (bet > 0 && myMoney >= bet) {
                    await supabase.from('players').update({ money: myMoney - bet, slot_count: player.slot_count + 1, last_slot_time: Date.now() }).eq('account_id', senderId);
                    
                    let r = Math.random() * 100, omi = (player.omikuji_date === today) ? player.omikuji_result : null, oM = "";
                    if(omi === '大吉') { r = Math.max(0, r - 0.4); oM = "(⛩️大吉ボーナス!)"; } 
                    else if(omi === '中吉') { r = Math.max(0, r - 0.2); oM = "(⛩️中吉ボーナス)"; } 
                    else if(omi === '凶') { r += 0.05; } 
                    else if(omi === '大凶') { r += 0.09; }
                    
                    let ml = 0, sy = "", res = "";
                    if(r < 0.1){ ml=100; sy="🐉 | 🐉 | 🐉"; res="🔥 超大当たり！！！ (100倍) 🔥"; } 
                    else if(r < 3.1){ ml=10; sy="7️⃣ | 7️⃣ | 7️⃣"; res="✨ 大当たり！ (10倍) ✨"; } 
                    else if(r < 9.1){ ml=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (3倍)"; } 
                    else if(r < 19.1){ ml=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (2倍)"; } 
                    else if(r < 29.1){ ml=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sy=`${s} | ${s} | ${s}`; res="🍇 フルーツ揃い！ (2倍)"; } 
                    else if(r < 49.1){ ml=2; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1=o[Math.floor(Math.random()*o.length)], s2=o[Math.floor(Math.random()*o.length)]; let a=["🍒",s1,s2].sort(()=>Math.random()-0.5); sy=a.join(" | "); res="🍒 チェリー出現！ (2倍)"; } 
                    else { ml=0; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=o[Math.floor(Math.random()*o.length)], r2=o[Math.floor(Math.random()*o.length)], r3=o[Math.floor(Math.random()*o.length)]; while(r1===r2&&r2===r3) r3=o[Math.floor(Math.random()*o.length)]; sy=`${r1} | ${r2} | ${r3}`; res="💀 はずれ..."; }
                    
                    let wA = bet * ml; if (wA > 0) await addMoneyWithRepay(senderId, wA);
                    
                    return sendMessage(roomId, `[info][title]🎰 SLOT MACHINE ${oM}[/title]${makeReplyTag(senderId, roomId, msgId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${formatNumber(bet)} ➡ 獲得: ${formatNumber(wA)} コイン\n(残り回数: ${5 - (player.slot_count + 1)}回)[/info]`);
                } else return sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)} お金が足りません！[/info]`);
            }

            // --- 🎟️ 宝くじ ---
            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
            if (lM && gambleActive) {
                let md = lM[2] || 'バラ', cnt = lM[3] ? parseInt(lM[3], 10) : 1;
                if (cnt > 0 && cnt <= 1000) {
                    let cost = cnt * 100; 
                    if (myMoney < cost) return sendTempMessage(roomId, `[info]⚠️ お金が足りません！(${cnt}枚 = ${formatNumber(cost)} コイン)[/info]`);
                    
                    const { data: lD } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = lD ? JSON.parse(lD.value) : [], uN = new Set(tks.map(t=>t.num)), mN = [];
                    
                    if (md === '連番') {
                        let st=-1, rs=Math.floor(Math.random()*(10000-cnt))+1;
                        for(let i=0; i<10000; i++){ 
                            let s = ((rs+i) % (10000-cnt)) + 1; 
                            let ok = true; 
                            for(let j=0; j<cnt; j++){ if(uN.has(s+j)){ ok=false; break; } } 
                            if(ok){ st=s; break; } 
                        }
                        if(st === -1) return sendTempMessage(roomId, `[info]⚠️ 連続した空き番号がありません。[/info]`);
                        for(let j=0; j<cnt; j++) mN.push(st+j);
                    } else {
                        let av=[]; for(let i=1; i<=9999; i++) if(!uN.has(i)) av.push(i);
                        if(av.length < cnt) return sendTempMessage(roomId, `[info]⚠️ 残りのくじが足りません。[/info]`);
                        for(let i=av.length-1; i>0; i--){ const r=Math.floor(Math.random()*(i+1)); [av[i],av[r]]=[av[r],av[i]]; } 
                        mN = av.slice(0, cnt);
                    }
                    
                    await supabase.from('players').update({ money: myMoney - cost }).eq('account_id', senderId);
                    for (let n of mN) tks.push({ aid: senderId, num: n });
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tks) });
                    
                    let ns = mN.length > 5 ? mN.slice(0,5).join(', ') + ` ...他${cnt-5}枚` : mN.join(', ');
                    return sendTempMessage(roomId, `[info][title]🎟 宝くじ購入完了[/title][piconname:${senderId}] 様\n宝くじを ${cnt} 枚（${md}）購入しました！\n番号: ${ns}\n\n(※抽選は深夜0時に行われます)[/info]`);
                }
            }

            // --- 🎲 ゲーム共通 (募集・参加・開始・退出) ---
            if (body.match(/(^|\n)\/(chouhan|cc|derby|bj|poker|yacht|sicbo)\b/) && gambleActive) {
                if (gameState[roomId]) return sendTempMessage(roomId, `[info][title]⚠️ エラー[/title]現在、別のゲームが進行中です。終了までお待ちください。[/info]`);
                
                let t = body.match(/(^|\n)\/(chouhan|cc|derby|bj|poker|yacht|sicbo)\b/)[2];
                gameState[roomId] = { type: t, state: 'RECRUITING', host: senderId, players: [{ aid: senderId, bet: 0 }] };
                
                let tN = t==='derby' ? "🐎 みんなでダービー" : (t==='cc' ? "🎲 チンチロリン" : (t==='bj' ? "🃏 ブラックジャック" : (t==='poker' ? "🃏 ポーカー" : (t==='yacht' ? "🎲 ヨット" : (t==='sicbo' ? "🎲 シックボー(大小)" : "🎲 丁半ゲーム"))))); 
                let ex = `[code]/join ${t}[/code]`;
                
                if (t === 'derby') {
                    let dO = generateDerby(); 
                    gameState[roomId].oddsMap = dO.oddsMap; 
                    gameState[roomId].oddsStr = dO.oddsStr; 
                    gameState[roomId].st = dO.stats;
                }
                
                sendTempMessage(roomId, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${senderId}]\n\n参加者は ${ex} と入力！(現在 1人)\n[hr]※1分経過で自動進行します。[/info]`); 
                startGameTimer(roomId); 
                return;
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|cc|derby|bj|poker|yacht|sicbo)/) && gambleActive && gameState[roomId]?.state === 'RECRUITING') {
                if (!gameState[roomId].players.find(x => x.aid === senderId)) { 
                    gameState[roomId].players.push({ aid: senderId, bet: 0 }); 
                    sendMessage(roomId, `[info]🙋‍♂️ [piconname:${senderId}] が参加しました！ (現在 ${gameState[roomId].players.length}人)[/info]`); 
                }
                return;
            }

            if (body.match(/(^|\n)\/start(chouhan|cc|derby|bj|poker|yacht|sicbo)/) && gambleActive && gameState[roomId]?.state === 'RECRUITING' && gameState[roomId].host === senderId) {
                if (gameState[roomId].players.length < 2 && !['bj','poker','yacht','cc','sicbo'].includes(gameState[roomId].type)) return sendTempMessage(roomId, `[info]⚠️ 参加者が2人以上でないと開始できません。[/info]`);
                clearTimeout(gameState[roomId].timeoutId); 
                handleGameTimeout(roomId); 
                return;
            }

            if (body.trim() === '/leave' && gambleActive && gameState[roomId]) {
                let idx = gameState[roomId].players.findIndex(p => p.aid === senderId);
                if (idx !== -1) {
                    let p = gameState[roomId].players[idx]; 
                    gameState[roomId].players.splice(idx, 1);
                    if (p.bet > 0) await addMoneyWithRepay(senderId, p.bet); // 返金
                    
                    sendTempMessage(roomId, `[info]🚪 [piconname:${senderId}] が退出しました。[/info]`);
                    if (gameState[roomId].players.length === 0) { 
                        clearTimeout(gameState[roomId].timeoutId); 
                        if (gameState[roomId].remindId) clearTimeout(gameState[roomId].remindId);
                        gameState[roomId] = null; 
                        return sendTempMessage(roomId, `[info]⚠️ 参加者がいなくなったため、ゲームを中止します。[/info]`); 
                    }
                    checkGameProgress(roomId);
                }
                return;
            }

            // --- 🎲 ゲーム (ベット・アクション) ---
            const bM = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([a-zA-Z0-9-]+))?/);
            if (bM && gambleActive && gameState[roomId]?.state === 'BETTING') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && pl.bet === 0) {
                    let b = bM[2] === 'max' ? myMoney : (bM[2] === 'half' ? Math.floor(myMoney/2) : parseInt(bM[2], 10));
                    if (b > 0 && myMoney >= b) {
                        if (gameState[roomId].type === 'derby') {
                            let h = bM[3]; 
                            if (!h || !gameState[roomId].oddsMap[h]) return sendTempMessage(roomId, `[info]⚠️ 馬連(例: 1-2)を正しく指定してください\n例: [code]/bet 100 1-2[/code][/info]`);
                            pl.choice = h;
                        } else if (gameState[roomId].type === 'sicbo') {
                            let h = bM[3]; 
                            if (!h || !['dai','shou','any'].includes(h)) return sendTempMessage(roomId, `[info]⚠️ 予想(dai/shou/any)を正しく指定してください\n例: [code]/bet 100 dai[/code][/info]`);
                            pl.choice = h;
                        }
                        pl.bet = b; 
                        await supabase.from('players').update({ money: myMoney - b }).eq('account_id', senderId);
                        sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] ${formatNumber(b)} コインをベットしました！[/info]`);
                        checkGameProgress(roomId);
                    } else sendTempMessage(roomId, `[info]⚠️ ${makeReplyTag(senderId, roomId, msgId)} お金が足りません！[/info]`);
                }
                return;
            }

            if ((body.trim() === '/chou' || body.trim() === '/han') && gambleActive && gameState[roomId]?.type === 'chouhan' && gameState[roomId].state === 'ACTION') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && !pl.choice) { 
                    pl.choice = body.trim().slice(1); 
                    sendTempMessage(roomId, `[info]🎯 [piconname:${senderId}] 「${pl.choice==='chou'?'丁(偶数)':'半(奇数)'}」を選択しました！[/info]`); 
                    checkGameProgress(roomId); 
                }
            }

            if (body.trim() === '/roll' && gambleActive && gameState[roomId]?.type === 'cc' && gameState[roomId].state === 'ACTION') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && !pl.res) {
                    pl.res = generateChinchiroRoll(); 
                    sendMessage(roomId, `[info]🎲 [piconname:${senderId}] の出目: ${pl.res.name}[/info]`); 
                    checkGameProgress(roomId);
                }
            }

            // --- ポーカー・ヨット (交換 / 振り直し) ---
            if (body.match(/(^|\n)\/change\b/) && gambleActive && (gameState[roomId]?.type === 'poker' || gameState[roomId]?.type === 'yacht') && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId];
                let pl = g.players[g.turnIndex];
                if (pl && pl.aid === senderId && pl.status === 'playing') {
                    let match = body.match(/(^|\n)\/change\s+([0-9\s]+)/);
                    if (match) {
                        let nums = match[2].trim().split(/\s+/).map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= 5);
                        
                        if (g.type === 'poker') {
                            for (let n of nums) pl.hand[n-1] = g.deck.pop();
                            pl.status = 'stand';
                            let handStr = pl.hand.map(c => c.suit + c.rank).join(' ');
                            let ev = evaluatePokerHand(pl.hand);
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] 交換完了\n確定手札: ${handStr} (${ev.name})[/info]`);
                            g.turnIndex++; 
                            await proceedNextPokerTurn(roomId);
                        } else if (g.type === 'yacht') {
                            for (let n of nums) pl.dice[n-1] = Math.floor(Math.random() * 6) + 1;
                            pl.rolls++;
                            
                            if (pl.rolls >= 3) {
                                pl.status = 'stand';
                                let diceStr = pl.dice.map(d => `🎲${d}`).join(' ');
                                let ev = evaluateYacht(pl.dice);
                                await sendTempMessage(roomId, `[info][piconname:${pl.aid}] 3回目の振り直し完了！\n確定サイコロ: ${diceStr} (${ev.name})[/info]`);
                                g.turnIndex++;
                                await proceedNextYachtTurn(roomId);
                            } else {
                                let diceStr = pl.dice.map((d, i) => `[${i+1}] 🎲${d}`).join('   ');
                                let ev = evaluateYacht(pl.dice);
                                await sendTempMessage(roomId, `[info][title]🎲 ヨット ターン継続 ( ${pl.rolls}/3 回目 )[/title][piconname:${pl.aid}]\nサイコロ: ${diceStr} (${ev.name})\n\n👉 [code]/change [番号][/code] または [code]/stand[/code][/info]`);
                                startGameTimer(roomId, 60000);
                            }
                        }
                    } else {
                        await sendTempMessage(roomId, `[info]⚠️ 交換/振り直す番号(1〜5)を指定してください。\n例: [code]/change 1 3 5[/code]\nそのまま確定する場合は [code]/stand[/code][/info]`);
                    }
                }
            }

            // --- ブラックジャック・ポーカー・ヨット共通 (ヒット・スタンド) ---
            const isHitOrStand = body.trim() === '/hit' || body.trim() === '/stand';
            if (isHitOrStand && gambleActive && (gameState[roomId]?.type === 'bj' || gameState[roomId]?.type === 'poker' || gameState[roomId]?.type === 'yacht') && gameState[roomId].state === 'ACTION') {
                let g = gameState[roomId];
                let pl = g.players[g.turnIndex];
                
                if (pl && pl.aid === senderId && pl.status === 'playing') {
                    if (body.trim() === '/hit') {
                        if (g.type !== 'bj') return;
                        
                        let c = g.deck.pop();
                        pl.hand.push(c);
                        
                        let score = calculateBJScore(pl.hand);
                        let hStr = pl.hand.map(cd => cd.suit + cd.rank).join(' ');
                        
                        if (score > 21) {
                            pl.status = 'bust';
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] ➡ 引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n💥 バーストしました！[/info]`);
                            g.turnIndex++; await proceedNextBJTurn(roomId);
                        } else if (score === 21) {
                            pl.status = 'stand';
                            await sendTempMessage(roomId, `[info][piconname:${pl.aid}] ➡ 引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n✨ 21到達！自動スタンドします。[/info]`);
                            g.turnIndex++; await proceedNextBJTurn(roomId);
                        } else {
                            await sendTempMessage(roomId, `[info][title]🃏 ターン継続[/title][piconname:${pl.aid}]\n引いたカード: ${c.suit}${c.rank}\n手札: ${hStr} (スコア: ${score})\n\n👉 [code]/hit[/code] または [code]/stand[/code][/info]`);
                            startGameTimer(roomId, 60000);
                        }
                    } else if (body.trim() === '/stand') {
                        pl.status = 'stand';
                        let desc = '';
                        if (g.type === 'poker') {
                            desc = `確定手札: ${pl.hand.map(c => c.suit + c.rank).join(' ')} (${evaluatePokerHand(pl.hand).name})`;
                        } else if (g.type === 'yacht') {
                            desc = `確定サイコロ: ${pl.dice.map(d => `🎲${d}`).join(' ')} (${evaluateYacht(pl.dice).name})`;
                        } else {
                            desc = `スコア: ${calculateBJScore(pl.hand)}`;
                        }
                        await sendTempMessage(roomId, `[info][piconname:${pl.aid}] スタンドしました。\n${desc}[/info]`);
                        
                        g.turnIndex++; 
                        if (g.type === 'poker') await proceedNextPokerTurn(roomId);
                        else if (g.type === 'yacht') await proceedNextYachtTurn(roomId);
                        else await proceedNextBJTurn(roomId);
                    }
                }
            }

        } catch (error) { console.error(error); }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;
