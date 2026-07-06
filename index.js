const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (r, res, b) => { r.rawBody = b; } }));

const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let isGamble = false;
let localLastReset = null; 
const spams = {};
const gSt = {}; // ch, cc, db の状態管理

// --- 初期化 & 日付管理 ---
sb.from('config').select('value').eq('key', 'gamble_active').single().then(r => { if(r.data) isGamble = r.data.value === 'true'; }).catch(()=>{});
const getJST = () => new Date(Date.now() + 9 * 3600000);
const getToday = () => getJST().toISOString().split('T')[0];
const getMonth = () => getJST().toISOString().slice(0, 7);
const fNum = n => Number(n).toLocaleString();
const verify = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    return sig && sig === crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
};

// --- チャット操作系 ---
const sendTemp = async (rid, txt, ms = 60000) => {
    try {
        const res = await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`);
        if (res?.data?.message_id) setTimeout(() => cw.delete(`/rooms/${rid}/messages/${res.data.message_id}`).catch(()=>{}), ms);
    } catch(e) {}
};
const sendMsg = (rid, txt) => cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`).catch(()=>{});
const mkRp = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;

// --- お金・権限管理 ---
const addMoney = async (aid, amt) => {
    const { data } = await sb.from('players').select('*').eq('account_id', aid).single();
    let m = data ? data.money : 0, d = data ? (data.debt || 0) : 0;
    if (d > 0 && amt > 0) { let r = Math.min(d, amt); d -= r; amt -= r; }
    m += amt;
    if (data) await sb.from('players').update({ money: m, debt: d }).eq('account_id', aid);
    else await sb.from('players').insert({ account_id: aid, money: m, debt: d });
};

const isAdmin = async (rid, aid) => {
    try {
        const { data } = await cw.get(`/rooms/${rid}/members`);
        const m = data.find(x => x.account_id.toString() === aid.toString());
        return m && (m.role === 'admin' || m.role === 'creator');
    } catch(e) { return false; }
};

const kickTarget = async (rid, aids, act = 'readonly') => {
    try {
        const { data: c } = await cw.get(`/rooms/${rid}/members`);
        let ad = c.filter(m=>m.role==='admin'||m.role==='creator').map(m=>m.account_id.toString());
        let me = c.filter(m=>m.role==='member').map(m=>m.account_id.toString());
        let ro = c.filter(m=>m.role==='readonly').map(m=>m.account_id.toString());
        let found = false;
        for (let a of aids) {
            let id = a.toString();
            if (ad.includes(id) || me.includes(id) || ro.includes(id)) found = true;
            ad = ad.filter(x=>x!==id); me = me.filter(x=>x!==id); ro = ro.filter(x=>x!==id);
            if (act === 'readonly') ro.push(id);
        }
        if (!found) return; 
        const p = new URLSearchParams();
        if (ad.length) p.append('members_admin_ids', ad.join(','));
        if (me.length) p.append('members_member_ids', me.join(','));
        if (ro.length) p.append('members_readonly_ids', ro.join(','));
        await cw.put(`/rooms/${rid}/members`, p.toString());
    } catch(e) {}
};

// --- ゲームエンジン系 ---
const genDerby = () => {
    let st = []; for(let i=0;i<6;i++) st.push(Math.random()*10+1);
    let combos = [], tot = 0;
    for(let i=1;i<=5;i++){ for(let j=i+1;j<=6;j++){ let w = st[i-1]*st[j-1]; combos.push({c:`${i}-${j}`, w}); tot+=w; } }
    let mp = {}, s = "";
    combos.forEach(c => {
        let o = (0.8 / (c.w/tot)).toFixed(1);
        if(o<1.1) o=1.1; if(o>150) o=150.0; mp[c.c] = Number(o);
    });
    Object.keys(mp).sort((a,b)=>mp[a]-mp[b]).forEach(k => { s += `🐎 ${k} : ${mp[k]}倍\n`; });
    return { mp, s, st };
};

const getChinchiro = () => {
    for (let i = 0; i < 3; i++) {
        let d = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1].sort((a,b)=>a-b);
        if (d[0]===1&&d[1]===1&&d[2]===1) return { d, n: "ピンゾロ", r: 6, s: 1, m: 5 };
        if (d[0]===d[1]&&d[1]===d[2]) return { d, n: `${d[0]}の嵐`, r: 5, s: d[0], m: 3 };
        if (d[0]===4&&d[1]===5&&d[2]===6) return { d, n: "シゴロ", r: 4, s: 6, m: 2 };
        if (d[0]===1&&d[1]===2&&d[2]===3) return { d, n: "ヒフミ", r: 0, s: 0, m: -2 };
        if (d[0]===d[1]) return { d, n: `${d[2]}の目`, r: 2, s: d[2], m: 1 };
        if (d[1]===d[2]) return { d, n: `${d[0]}の目`, r: 2, s: d[0], m: 1 };
        if (d[0]===d[2]) return { d, n: `${d[1]}の目`, r: 2, s: d[1], m: 1 };
    }
    return { d: [0,0,0], n: "目なし", r: 1, s: 0, m: 1 };
};

const chkProg = async (rid) => {
    let g = gSt[rid]; if (!g || g.s === 'IDLE') return;
    if (g.s === 'BET' && g.p.length >= 2 && g.p.every(x => x.b > 0)) {
        if (g.t === 'db') { clearTimeout(g.tid); await resDerby(rid); }
        else {
            g.s = 'ACT';
            let txt = g.t === 'ch' ? "丁半を予想し、 /chou (丁) または /han (半) と発言してください。" : "親以外は /roll でサイコロを振ってください。";
            await sendTemp(rid, `[info][title]🎲 ゲーム進行[/title]全員のベットが完了しました！\n${txt}\n(制限1分)[/info]`);
            setT(rid);
        }
    } else if (g.s === 'ACT') {
        if (g.t === 'ch' && g.p.length >= 2 && g.p.every(x => x.c)) await resChouhan(rid);
        if (g.t === 'cc' && g.p.length >= 2 && g.p.filter(x => x.a !== g.h).every(x => x.r)) await resChinchiro(rid);
    }
};

const hTO = async (rid) => {
    let g = gSt[rid]; if (!g || g.s === 'IDLE') return;
    if (g.s === 'REC') {
        if (g.p.length >= 2) {
            g.s = 'BET';
            let ex = g.t === 'db' ? `\n[b]【 馬連オッズ 】[/b]\n${g.s}\n/bet [額|max|half] [馬番-馬番] (例: /bet 100 1-2)` : `\n/bet [額|max|half] でベットしてください。`;
            await sendTemp(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${ex}\n(制限1分)[/info]`);
            setT(rid);
        } else {
            await sendTemp(rid, `[info]⚠️ 参加者が2人未満のため、ゲームを中止します。[/info]`);
            gSt[rid] = null;
        }
    } else {
        let kick = [], act = [];
        for (let p of g.p) {
            let k = false;
            if (g.s === 'BET' && p.b === 0) k = true;
            if (g.s === 'ACT' && (g.t === 'ch' && !p.c || g.t === 'cc' && !p.r && p.a !== g.h)) k = true;
            if (k) { kick.push(p.a); if (p.b > 0) await addMoney(p.a, p.b); } else act.push(p);
        }
        g.p = act;
        if (kick.length > 0) await sendTemp(rid, `[info]⏳ タイムアウトにより退出・返金:\n${kick.map(a=>`[piconname:${a}]`).join(' ')}[/info]`);
        if (g.p.length < 2) {
            for (let p of g.p) if (p.b > 0) await addMoney(p.a, p.b);
            await sendTemp(rid, `[info]人数不足になったため中止し、全額返金しました。[/info]`);
            gSt[rid] = null;
        } else chkProg(rid);
    }
};

const setT = (rid, ms = 60000) => { if (gSt[rid]?.tid) clearTimeout(gSt[rid].tid); if (gSt[rid]) gSt[rid].tid = setTimeout(() => hTO(rid), ms); };

const resChinchiro = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let pR = getChinchiro(); 
    let msg = `[info][title]🎲 チンチロリン 結果発表[/title]【 親 ([piconname:${g.h}]) の出目 】\n[ ${pR.d.join(', ')} ] ➡ 『 ${pR.n} 』\n[hr]【 プレイヤー結果 】\n`;
    for (let p of g.p) {
        if (p.a === g.h) continue;
        let r = p.r || { r: 1, n: "欠席", m: 1, s: 0, d: [0,0,0] };
        let win = (r.r > pR.r) || (r.r === pR.r && r.s > pR.s);
        let draw = (r.r === pR.r && r.s === pR.s);
        if (draw) { await addMoney(p.a, p.b); msg += `😐 [piconname:${p.a}]: [${r.d.join('')}] ${r.n} ➡ 引き分け (返金)\n`; }
        else if (win) { let m = r.m>0?r.m:1; await addMoney(p.a, p.b+(p.b*m)); msg += `🎉 [piconname:${p.a}]: [${r.d.join('')}] ${r.n} ➡ 勝ち！ (+${fNum(p.b*m)})\n`; }
        else { msg += `💀 [piconname:${p.a}]: [${r.d.join('')}] ${r.n} ➡ 負け\n`; }
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const resChouhan = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let d1 = Math.floor(Math.random()*6)+1, d2 = Math.floor(Math.random()*6)+1, s = d1+d2, ans = (s%2===0)?'chou':'han';
    let msg = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1} と ${d2} (合計:${s}) ➡ 『 ${ans==='chou'?'丁(偶数)':'半(奇数)'} 』\n[hr]`;
    for (let p of g.p) {
        if (p.c === ans) { await addMoney(p.a, p.b*2); msg += `🎉 [piconname:${p.a}]: 的中！ (+${fNum(p.b*2)})\n`; }
        else msg += `💀 [piconname:${p.a}]: 予想[${p.c==='chou'?'丁':'半'}] ➡ はずれ...\n`;
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const resDerby = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let st = g.st, ws = [...st], tW = ws.reduce((a,b)=>a+b,0);
    let r1 = Math.random() * tW, s1 = 0, first = 1;
    for(let i=0; i<6; i++){ s1+=ws[i]; if(r1<=s1){ first=i+1; break; } }
    ws[first-1] = 0; tW = ws.reduce((a,b)=>a+b,0);
    let r2 = Math.random() * tW, s2 = 0, second = 1;
    for(let i=0; i<6; i++){ s2+=ws[i]; if(r2<=s2){ second=i+1; break; } }
    
    let winC = first < second ? `${first}-${second}` : `${second}-${first}`, odd = g.mp[winC];
    let msg = `[info][title]🐎 ダービー レース結果[/title]各馬一斉にスタート！\n...\n第4コーナーを回って最後の直線！\n...\n\n先頭で駆け抜けたのは【 ${first} 】番と【 ${second} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${winC} 】 (${odd}倍)\n[hr][b]【 プレイヤー結果 】[/b]\n`;
    for(let p of g.p){
        if(p.c === winC){ let w = Math.floor(p.b * odd); await addMoney(p.a, p.b + w); msg += `🎉 [piconname:${p.a}]: 的中！ (+${fNum(w)} コイン)\n`; }
        else msg += `💀 [piconname:${p.a}]: 予想[${p.c}] ➡ はずれ...\n`;
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

// --- Webhook メイン ---
app.post('/webhook', (req, res) => {
    if (!verify(req)) return res.status(401).send();
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event;
    if (!ev || req.body.webhook_event_type !== 'message_created') return;

    const rid = ev.room_id, body = ev.body || "", sId = ev.account_id.toString(), mId = ev.message_id;
    const td = getToday(), tm = getMonth();

    (async () => {
        try {
            const rpM = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const rAid = rpM ? rpM[1] : null;

            // 1. ブラックリスト判定 & スパム
            const { data: isB } = await sb.from('blacklist').select('*').eq('account_id', sId).single();
            if (isB) { await kickTarget(rid, [sId], 'readonly'); await cw.delete(`/rooms/${rid}/messages/${mId}`).catch(()=>{}); return; }
            if (!spams[sId]) spams[sId]=[]; spams[sId].push(Date.now()); spams[sId]=spams[sId].filter(t=>Date.now()-t<=5000);
            if (spams[sId].length>=10 && !(await isAdmin(rid, sId))) { await kickTarget(rid, [sId], 'readonly'); return sendTemp(rid, `[info]⚠️ ${mkRp(sId,rid,mId)} 連投につき閲覧制限しました。[/info]`); }

            // 2. 日替わりリセット & 宝くじ
            if (localLastReset !== td) {
                const { data: ld } = await sb.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!ld || ld.value !== td) {
                    await sb.from('players').update({ slot_count: 0, work_limit: 5, work_date: null, skill_date: null, omikuji_date: null }).neq('account_id', '0');
                    await sb.from('config').upsert({ key: 'last_reset_date', value: td });
                    localLastReset = td;
                    let m = `[info][title]🔄 日付更新[/title]スロット・仕事回数・おみくじがリセットされました！\n[hr]`;
                    const { data: tData } = await sb.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = tData ? JSON.parse(tData.value) : [];
                    if (tks.length > 0) {
                        let win = Math.floor(Math.random() * 9999) + 1;
                        m += `[title]🎯 宝くじ抽選[/title]🟥 当選番号:【 ${win} 】\n[hr]`;
                        let pays = {}, wns = [];
                        const chP = (n, w) => {
                            if(n===w) return {p:30000, n:'🥇1等'}; let pr=w-1<1?9999:w-1, nx=w+1>9999?1:w+1;
                            if(n===pr||n===nx) return {p:15000, n:'🥈前後賞'};
                            if(n%1000===w%1000) return {p:10000, n:'🥈2等'}; if(n%100===w%100) return {p:5000, n:'🥉3等'}; if(n%10===w%10) return {p:1000, n:'🏅4等'}; return null;
                        };
                        for (let t of tks) { let r = chP(t.num, win); if(r){ wns.push({a:t.aid, num:t.num, ...r}); pays[t.aid]=(pays[t.aid]||0)+r.p; } }
                        if (wns.length > 0) {
                            for (let a in pays) await addMoney(a, pays[a]);
                            wns.sort((a,b)=>b.p-a.p); for(let w of wns.slice(0,20)) m += `✨ [piconname:${w.a}]: 予想[${w.num}] ➡ ${w.n} (+${fNum(w.p)})\n`;
                            if(wns.length>20) m += `...他 ${wns.length-20} 件の当選！\n`;
                        } else m += `⬜ 本日の当選者はいませんでした。\n`;
                        await sb.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                    }
                    sendMsg(rid, m + `[/info]`);
                }
            }

            // 3. データ取得 & 仕事サイレント回復
            const { data: p } = await sb.from('players').select('*').eq('account_id', sId).single();
            let mM=p?p.money:0, mD=p?(p.debt||0):0, mJ=p?(p.job||'サラリーマン'):'サラリーマン', cDb=(p&&p.debt_month===tm)?(p.monthly_debt||0):0;
            
            if (isGamble && !body.startsWith('/')) {
                let mc=(p?p.msg_count||0:0)+1; let wl=p?p.work_limit||5:5;
                if(mc >= (Math.floor(Math.random()*21)+30)){ mc=0; if(wl<10)wl++; }
                if(p) await sb.from('players').update({msg_count:mc, work_limit:wl}).eq('account_id', sId);
                else await sb.from('players').insert({account_id:sId, money:0, debt:0, work_limit:5, msg_count:1});
            }

            // --- ヘルプ ---
            if (body === '/help-gya') {
                const h = `[info][title]🎰 総合案内 (V34)[/title]
/status : 状態確認
/omikuji : 1日1回運勢占い (スロット確率変動)
/give [金] : 相手に送金 (税10%)
/debt [金] : 借金 (月上限5000)
/money-rank : 純資産ランキング
/job, /work, /catch, /goal : 職業関連
/slot [金|max|half] : スロット (1日3回)
/buy-lot [連番|バラ] [枚数] : 宝くじ
/chouhan, /cc, /derby : ゲーム募集
/bet [額|max|half] (馬番) : ベット
[b]【 管理 】[/b] /take [金], /st-gya, /fi-gya, /blacklist, /remove-rank[/info]`;
                return sendTemp(rid, h, 120000);
            }

            // --- 👑 管理者コマンド ---
            if (/(^|\n)\/take\b/.test(body) && isGamble && await isAdmin(rid, sId)) {
                let a = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2]||(body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                let tg = rAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if(tg && a>0){ await addMoney(tg, a); return sendTemp(rid, `[info]👑 🟥 [piconname:${tg}] へ ${fNum(a)} 資金付与[/info]`); }
            }

            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body)) {
                if (!(await isAdmin(rid, sId))) return;
                let tg = rAid || (body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
                let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'remove' : 'add');
                if(!tg && cmd !== 'add') return; if(!tg && cmd === 'add') cmd = 'list';

                if (cmd === 'rank') {
                    const { data: eD } = await sb.from('config').select('value').eq('key','rank_excluded').single();
                    let ex = eD ? JSON.parse(eD.value) : [];
                    if (ex.includes(tg)) { ex = ex.filter(i=>i!==tg); sendTemp(rid, `[info]🟨 [piconname:${tg}] ランク除外解除[/info]`); }
                    else { ex.push(tg); sendTemp(rid, `[info]🟥 [piconname:${tg}] ランク除外[/info]`); }
                    return await sb.from('config').upsert({key:'rank_excluded', value:JSON.stringify(ex)});
                }
                if (cmd === 'add') { await sb.from('blacklist').insert({account_id:tg}); await kickTarget(rid,[tg],'readonly'); return sendTemp(rid, `[info]🚫 🟥 [piconname:${tg}] 追放(閲覧のみ)[/info]`); }
                else if (cmd === 'remove') { await sb.from('blacklist').delete().eq('account_id',tg); return sendTemp(rid, `[info]✅ ⬜ [piconname:${tg}] 追放解除[/info]`); }
                else if (cmd === 'list') { const { data:ls } = await sb.from('blacklist').select('account_id'); return sendTemp(rid, `[info][title]📜 BL一覧[/title]${ls&&ls.length?ls.map(d=>`[piconname:${d.account_id}]`).join('\n'):'なし'}[/info]`); }
            }

            if(body.startsWith('/st-gya') && await isAdmin(rid,sId)){ isGamble=true; await sb.from('config').upsert({key:'gamble_active',value:'true'}); return sendMsg(rid, `[info]🎰 🟥 カジノON[/info]`); }
            if(body.startsWith('/fi-gya') && await isAdmin(rid,sId)){ isGamble=false; await sb.from('config').upsert({key:'gamble_active',value:'false'}); return sendMsg(rid, `[info]🚫 ⬜ カジノOFF[/info]`); }

            // --- ⛩️ 新機能: おみくじ ---
            if (body === '/omikuji' && isGamble) {
                if (p && p.omikuji_date === td) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)} 本日のおみくじは既に引いています。\n(結果: ${p.omikuji_result})[/info]`);
                let r = Math.random() * 100, res = "";
                if(r<10) res="大吉"; else if(r<30) res="中吉"; else if(r<60) res="小吉"; else if(r<85) res="吉"; else if(r<95) res="凶"; else res="大凶";
                
                let eff = "";
                if(res==="大吉") eff="✨ スロットの当たり確率が大幅UP！";
                else if(res==="中吉") eff="🌟 スロットの当たり確率が少しUP！";
                else if(res==="凶") eff="💧 スロットの当たり確率が少しDOWN...";
                else if(res==="大凶") eff="💀 スロットの当たり確率が大幅DOWN...";
                else eff="🎯 スロットの確率は通常通りです。";

                if (p) await sb.from('players').update({ omikuji_date: td, omikuji_result: res }).eq('account_id', sId);
                else await sb.from('players').insert({ account_id: sId, money: 0, debt: 0, omikuji_date: td, omikuji_result: res });
                
                return sendMsg(rid, `[info][title]⛩️ おみくじ結果[/title]${mkRp(sId, rid, mId)}\n[hr]あなたの今日の運勢は...【 ${res} 】です！\n\n${eff}[/info]`);
            }

            // --- 🏦 銀行関連 ---
            const dbM = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (dbM && isGamble) {
                let a = parseInt(dbM[2], 10);
                if (a > 0) {
                    if (cDb + a > 5000) return sendTemp(rid, `[info]⚠️ 🟨 ${mkRp(sId,rid,mId)} 月の借金上限(5000)です！[/info]`);
                    if (p) await sb.from('players').update({money:mM+a, debt:myD+a, monthly_debt:cDb+a, debt_month:tMonth}).eq('account_id',sId);
                    else await sb.from('players').insert({account_id:sId, money:a, debt:a, monthly_debt:a, debt_month:tMonth});
                    return sendTemp(rid, `[info]💳 🟨 [piconname:${sId}] ${fNum(a)}コイン借金しました。[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && isGamble) {
                let tg = rAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let a = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2]||(body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                if (tg && a > 0) {
                    let av = Math.max(0, mM - myD); if (av < a) return sendTemp(rid, `[info]⚠️ 🟨 ${mkRp(sId,rid,mId)} 送金枠(純資産)不足！[/info]`);
                    let tx = Math.floor(a * 0.10), rA = a - tx;
                    await sb.from('players').update({money: mM - a}).eq('account_id', sId);
                    const {data:rc} = await sb.from('players').select('*').eq('account_id',tg).single();
                    if(rc) await sb.from('players').update({money:rc.money+rA}).eq('account_id',tg); else await sb.from('players').insert({account_id:tg, money:rA, debt:0});
                    return sendTemp(rid, `[info]🎁 🟨 [piconname:${sId}] ➡ [piconname:${tg}]\n${fNum(a)}コイン送金 (税${fNum(tx)}, 受取${fNum(rA)})[/info]`);
                }
            }

            if (body === '/status') {
                let omi = (p && p.omikuji_date === td && p.omikuji_result) ? `\n⛩️ 運勢: ${p.omikuji_result}` : "";
                return sendTemp(rid, `[info][title]📊 状態[/title][piconname:${sId}]\n💰: ${fNum(mM)} ${myD>0?`\n💳: -${fNum(myD)}`:''}\n👔: ${myJ}\n🎰: 残${Math.max(0,3-(p?p.slot_count:0))} / 💼: 残${p?p.work_limit:0}${omi}[/info]`);
            }
            if (body === '/money-rank') {
                const { data: exD } = await sb.from('config').select('value').eq('key','rank_excluded').single(); let eI = exD?JSON.parse(exD.value):[];
                const { data: ls } = await sb.from('players').select('*'); let f = ls?ls.filter(d=>!eI.includes(d.account_id)):[];
                f.sort((a,b)=>((b.money||0)-(b.debt||0))-((a.money||0)-(a.debt||0)));
                let s = f.slice(0,10).map((d,i)=>{let n=(d.money||0)-(d.debt||0); let md=i===0?"🥇":(i===1?"🥈":(i===2?"🥉":"🔹")); return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰 ${fNum(n)} ${d.debt>0?`(借:-${fNum(d.debt)})`:''} [${d.job||'サラリーマン'}]`;}).join('\n[hr]');
                return sendTemp(rid, `[info][title]👑 純資産ランキング[/title]${s}[/info]`, 300000);
            }

            // --- 💼 職業 ---
            const jM = body.match(/^\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (jM && isGamble) {
                const jn = jM[1]; const cs = {'サラリーマン':0, '公務員':2000, '警察官':3000, 'プロスポーツ選手':5000};
                if (myJ === jn) return sendTemp(rid, `⚠️ ${mkRp(sId,rid,mId)} 既に${jn}です`);
                if (mM < cs[jn]) return sendTemp(rid, `⚠️ ${mkRp(sId,rid,mId)} お金不足(費:${cs[jn]})`);
                if (p) await sb.from('players').update({job:jn, money:mM-cs[jn]}).eq('account_id',sId); else await sb.from('players').insert({account_id:sId, job:jn, money:-cs[jn]});
                return sendTemp(rid, `[info]💼 🟨 [piconname:${sId}] ${jn} に転職！[/info]`);
            } else if (body === '/job' && isGamble) return sendTemp(rid, `[info][title]💼 求人[/title]サラリーマン(0) ➡ /work\n公務員(2000) ➡ /work\n警察官(3000) ➡ /work, /catch\nプロスポーツ選手(5000) ➡ /work, /goal\n[hr]※転職は /job 役職名[/info]`);

            if (body === '/work' && isGamble && p) {
                if (p.work_limit <= 0) return sendTemp(rid, `⚠️ ${mkRp(sId,rid,mId)} 本日上限`);
                if (Date.now()-(p.last_work_time||0)<600000) return sendTemp(rid, `⚠️ ${mkRp(sId,rid,mId)} 休憩中(10分間隔)`);
                let e=0, m="";
                if(myJ==='サラリーマン'){ if(Math.random()<0.1){e=0;m="⬜ ミスで給料0...";} else {e=Math.floor(Math.random()*401)+100;m=`🟨 ${fNum(e)}獲得`;} }
                else if(myJ==='公務員'){ e=Math.floor(Math.random()*201)+300; m=`🟨 ${fNum(e)}獲得`; }
                else if(myJ==='警察官'){ e=Math.floor(Math.random()*401)+300; m=`🟨 ${fNum(e)}獲得`; }
                else if(myJ==='プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`🟨 ${fNum(e)}獲得`; }
                await sb.from('players').update({last_work_time:Date.now(), work_limit:p.work_limit-1}).eq('account_id',sId);
                await addMoney(sId, e); return sendTemp(rid, `[info]💼 ${mkRp(sId,rid,mId)}\n${m} (残${p.work_limit-1})[/info]`);
            }

            if ((body === '/catch' || body === '/goal') && isGamble && p) {
                let iC = body === '/catch';
                if (iC && myJ !== '警察官') return sendTemp(rid, `⚠️ 警察官専用`); if (!iC && myJ !== 'プロスポーツ選手') return sendTemp(rid, `⚠️ プロ専用`);
                if (p.skill_date === today) return sendTemp(rid, `⚠️ 本日使用済`);
                let sc = Math.random() < 0.3, e = 0, m = "";
                if (iC) { if(sc){e=800;m=`🟥 逮捕！特別報酬 ${e}`;} else m=`⬜ 逃しました...`; }
                else { if(sc){e=1000;m=`🟥 スーパーゴール！報酬 ${e}`;} else m=`⬜ 外れました...`; }
                await sb.from('players').update({skill_date:today}).eq('account_id',sId);
                await addMoney(sId, e); return sendTemp(rid, `[info]✨ ${mkRp(sId,rid,mId)}\n${m}[/info]`);
            }

            // --- 🎰 スロット ---
            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && isGamble && p) {
                if (p.slot_count >= 3) return sendTemp(rid, `⚠️ ${mkRp(sId,rid,mId)} 本日上限(1日3回)`);
                if (Date.now()-(p.last_slot_time||0)<600000) return sendTemp(rid, `⚠️ ${mkRp(sId,rid,mId)} 休憩中(10分間隔)`);
                let bet = sM[2]==='max'?mM:(sM[2]==='half'?Math.floor(mM/2):parseInt(sM[2],10));
                if (bet > 0 && mM >= bet) {
                    await sb.from('players').update({money:mM-bet, slot_count:p.slot_count+1, last_slot_time:Date.now()}).eq('account_id',sId);
                    
                    // ★おみくじバフ適用
                    let r = Math.random() * 100;
                    let omi = (p.omikuji_date === today) ? p.omikuji_result : null;
                    let omiMsg = "";
                    if (omi === '大吉') { r = Math.max(0, r - 10); omiMsg = "(⛩️大吉ボーナス適用!)"; }
                    else if (omi === '中吉') { r = Math.max(0, r - 5); omiMsg = "(⛩️中吉ボーナス適用)"; }
                    else if (omi === '凶') { r = Math.min(99, r + 5); }
                    else if (omi === '大凶') { r = Math.min(99, r + 10); }

                    let ml=0, sy="", rs="";
                    if(r<1){ml=100;sy="🐉|🐉|🐉";rs="🟥 超大当たり！！！(100倍)";}else if(r<4){ml=10;sy="7️⃣|7️⃣|7️⃣";rs="🟥 大当たり！(10倍)";}else if(r<10){ml=3;let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)];sy=`${s}|${s}|${s}`;rs="🟨 当たり！(3倍)";}else if(r<20){ml=2;let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)];sy=`${s}|${s}|${s}`;rs="🟨 当たり！(2倍)";}else if(r<30){ml=2;let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)];sy=`${s}|${s}|${s}`;rs="🟨 フルーツ揃い！(2倍)";}else if(r<50){ml=2;let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"];let s1=o[Math.floor(Math.random()*o.length)],s2=o[Math.floor(Math.random()*o.length)];sy=["🍒",s1,s2].sort(()=>Math.random()-0.5).join("|");rs="🟨 チェリー！(2倍)";}else{ml=0;let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"];let r1=o[Math.floor(Math.random()*o.length)],r2=o[Math.floor(Math.random()*o.length)],r3=o[Math.floor(Math.random()*o.length)];while(r1===r2&&r2===r3)r3=o[Math.floor(Math.random()*o.length)];sy=`${r1}|${r2}|${r3}`;rs="⬜ はずれ...";}
                    
                    let wA = bet * ml; if (wA > 0) await addMoney(sId, wA);
                    return sendMsg(rid, `[info][title]🎰 SLOT ${omiMsg}[/title]${mkRp(sId,rid,mId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${rs}\n\n賭: ${fNum(bet)} ➡ 獲: ${fNum(wA)}\n(残り: ${3-(p.slot_count+1)}回)[/info]`);
                } else return sendTemp(rid, `⚠️ ${mkRp(sId,rid,mId)} お金不足`);
            }

            // --- 🎟️ 宝くじ ---
            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
            if (lM && isGamble) {
                let md = lM[2] || 'バラ', cnt = lM[3] ? parseInt(lM[3], 10) : 1;
                if (cnt > 0 && cnt <= 100) {
                    let cost = cnt * 100; if(mM < cost) return sendTemp(rid, `⚠️ お金不足！(${cnt}枚=${fNum(cost)}コイン)`);
                    const {data:lD} = await sb.from('config').select('value').eq('key','lottery_tickets').single();
                    let tks = lD ? JSON.parse(lD.value) : [], uN = new Set(tks.map(t=>t.num)), mN = [];
                    if (md === '連番') {
                        let st=-1, rs=Math.floor(Math.random()*(10000-cnt))+1;
                        for(let i=0;i<10000;i++){ let s=((rs+i)%(10000-cnt))+1; let ok=true; for(let j=0;j<cnt;j++){ if(uN.has(s+j)){ok=false;break;} } if(ok){st=s;break;} }
                        if(st===-1) return sendTemp(rid, `⚠️ 連続空き番号なし`);
                        for(let j=0;j<cnt;j++) mN.push(st+j);
                    } else {
                        let av=[]; for(let i=1;i<=9999;i++) if(!uN.has(i)) av.push(i);
                        if(av.length<cnt) return sendTemp(rid, `⚠️ 残りくじ不足`);
                        for(let i=av.length-1;i>0;i--){ const r=Math.floor(Math.random()*(i+1)); [av[i],av[r]]=[av[r],av[i]]; } mN=av.slice(0,cnt);
                    }
                    await sb.from('players').update({money:mM-cost}).eq('account_id',sId);
                    for(let n of mN) tks.push({aid:sId,num:n}); await sb.from('config').upsert({key:'lottery_tickets',value:JSON.stringify(tks)});
                    let ns = mN.length>5 ? mN.slice(0,5).join(', ')+` ...他${cnt-5}枚` : mN.join(', ');
                    return sendTemp(rid, `[info]🎟 🟨 ${mkRp(sId,rid,mId)}\n宝くじ ${cnt}枚（${md}）購入！\n番号: ${ns}[/info]`);
                }
            }

            // --- 🎲 ゲーム共通・進行 ---
            const { data: lg } = await sb.from('config').select('value').eq('key', 'last_game_time').single();
            const gCD = (Date.now() - parseInt(lg ? lg.value : 0)) < 180000;

            if (body.match(/(^|\n)\/(chouhan|cc|derby)\b/) && isGamble) {
                if (gSt[rid]) return sendTemp(rid, `⚠️ 他のゲームが進行中です`);
                if (gCD) return sendTemp(rid, `⚠️ ゲームは3分間隔です`);
                let t = body.includes('/derby')?'db':(body.includes('/cc')?'cc':'ch');
                gSt[rid] = { type: t, state: 'REC', host: sId, p: [{a:sId, b:0}], mp:{}, s:"", st:[] };
                let tN = t==='db'?"🐎 ダービー":(t==='cc'?"🎲 チンチロリン":"🎲 丁半"); let ex = t==='db'?"/join derby":(t==='cc'?"/join cc":"/join chouhan");
                if (t==='db') { let dO=genDb(); gSt[rid].mp=dO.mp; gSt[rid].s=dO.s; gSt[rid].st=dO.st; }
                sendTemp(rid, `[info][title]${tN} 募集[/title]親:[piconname:${sId}]\n${ex} で参加！(1分)[/info]`); setT(rid); return;
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|cc|derby)/) && isGamble && gSt[rid]?.state === 'REC') {
                if (!gSt[rid].p.find(x=>x.a===sId)) { gSt[rid].p.push({a:sId, b:0}); sendMsg(rid, `[info]🟨 [piconname:${sId}] 参加！ (${gSt[rid].p.length}人)[/info]`); }
                return;
            }

            if (body.match(/(^|\n)\/start(chouhan|cc|derby)/) && isGamble && gSt[rid]?.state === 'REC' && gSt[rid].host === sId) {
                if (gSt[rid].p.length < 2) return sendTemp(rid, `⚠️ 2人以上必要`);
                clearTimeout(gSt[rid].tid); hTO(rid); return;
            }

            if (body === '/leave' && isGamble && gSt[rid]) {
                let ix = gSt[rid].p.findIndex(x=>x.a===sId);
                if (ix !== -1) {
                    let cp = gSt[rid].p[ix]; gSt[rid].p.splice(ix,1); if(cp.b>0) await addMoney(sId,cp.b);
                    sendTemp(rid, `[info]⬜ [piconname:${sId}] 退出[/info]`);
                    if(gSt[rid].p.length===0) { clearTimeout(gSt[rid].tid); gSt[rid]=null; return sendTemp(rid, `[info]⚠️ 参加者0で中止[/info]`); }
                    chkProg(rid);
                } return;
            }

            const bM = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([0-9]+-[0-9]+))?/);
            if (bM && isGamble && gSt[rid]?.state === 'BET') {
                let pl = gSt[rid].p.find(x=>x.a===sId);
                if (pl && pl.b===0) {
                    let b = bM[2]==='max'?mM:(bM[2]==='half'?Math.floor(mM/2):parseInt(bM[2],10));
                    if (b>0 && mM>=b) {
                        if (gSt[rid].type === 'db') {
                            let h = bM[3]; if(!h || !gSt[rid].mp[h]) return sendTemp(rid, `⚠️ 馬連(例: 1-2)を指定`);
                            pl.c = h;
                        }
                        pl.b = b; await sb.from('players').update({money:mM-b}).eq('account_id',sId);
                        sendTemp(rid, `[info]🟨 [piconname:${sId}] ${fNum(b)}ベット！[/info]`); chkProg(rid);
                    } else sendTemp(rid, `⚠️ ${mkRp(sId,rid,mId)} お金不足`);
                } return;
            }

            if ((body==='/chou'||body==='/han') && isGamble && gSt[rid]?.type==='ch' && gSt[rid].state==='ACT') {
                let pl = gSt[rid].p.find(x=>x.a===sId);
                if (pl && !pl.c) { pl.c=body.slice(1); sendTemp(rid, `[info]🟨 [piconname:${sId}] 「${pl.c==='chou'?'丁':'半'}」選択[/info]`); chkProg(rid); }
            }

            if (body==='/roll' && isGamble && gSt[rid]?.type==='cc' && gSt[rid].state==='ACT') {
                let pl = gSt[rid].p.find(x=>x.a===sId);
                if (pl && !pl.res && sId!==gSt[rid].host) {
                    pl.res=getRoll(); sendMsg(rid, `[info]🎲 [piconname:${sId}] の出目: ${pl.res.n}[/info]`); chkProg(rid);
                }
            }

        } catch (e) { console.error(e); }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;
