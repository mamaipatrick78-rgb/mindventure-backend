import express from 'express'; import cors from 'cors'; import helmet from 'helmet'; import bcrypt from 'bcryptjs'; import jwt from 'jsonwebtoken'; import 'dotenv/config';
import {z} from 'zod'; import {q} from './db.js'; import {custody} from '../custody/adapter.js';
import {runTradingCycle, startScheduler} from './trading-engine.js';
import {generateSignal} from './strategy.js';
import {getPriceHistory, getMarketOverview, TRADABLE_ASSETS} from './marketdata.js';
const app=express(); app.use(helmet()); app.use(cors({origin:process.env.CORS_ORIGIN||'*'})); app.use(express.json({limit:'1mb'}));
const secret=process.env.JWT_SECRET; if(!secret) throw Error('JWT_SECRET required');
const auth=(req,res,next)=>{try{const t=(req.headers.authorization||'').replace(/^Bearer /,''); req.user=jwt.verify(t,secret); next()}catch{res.status(401).json({error:'Unauthorized'})}};
const requireAdmin=async(req,res,next)=>{try{const r=await q('SELECT is_admin FROM users WHERE id=$1',[req.user.sub]);if(!r.rows[0]?.is_admin)return res.status(403).json({error:'Admin access required'});next()}catch{res.status(500).json({error:'Could not verify admin access'})}};
const assets=['BTC','ETH','USDT','SOL','BNB','MATIC','AVAX']; const schema=z.object({asset:z.enum(assets),network:z.string().min(2).max(50)});
app.get('/health',(req,res)=>res.json({ok:true}));
app.post('/api/auth/register',async(req,res)=>{try{const d=z.object({email:z.string().email(),password:z.string().min(12),fullName:z.string().min(2)}).parse(req.body);const h=await bcrypt.hash(d.password,12);const r=await q('INSERT INTO users(email,password_hash,full_name) VALUES($1,$2,$3) RETURNING id,email,full_name,kyc_status',[d.email.toLowerCase(),h,d.fullName]);res.status(201).json({user:r.rows[0]})}catch(e){res.status(e.code==='23505'?409:400).json({error:e.code==='23505'?'Email already registered':'Invalid registration'})}});
app.post('/api/auth/login',async(req,res)=>{const d=z.object({email:z.string().email(),password:z.string()}).parse(req.body);const r=await q('SELECT * FROM users WHERE email=$1',[d.email.toLowerCase()]);const u=r.rows[0];if(!u||!(await bcrypt.compare(d.password,u.password_hash)))return res.status(401).json({error:'Invalid credentials'});res.json({token:jwt.sign({sub:u.id},secret,{expiresIn:'15m'}),user:{id:u.id,email:u.email,fullName:u.full_name,kycStatus:u.kyc_status,isAdmin:u.is_admin}})});
app.get('/api/dashboard',auth,async(req,res)=>{const b=await q('SELECT asset,available,locked FROM balances WHERE user_id=$1 ORDER BY asset',[req.user.sub]);const t=await q('SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',[req.user.sub]);res.json({balances:b.rows,transactions:t.rows})});

// Real live prices + 24h change for every tradable asset, replacing the old static mockup.
app.get('/api/markets',auth,async(req,res)=>{
  try{
    const overview=await getMarketOverview([...TRADABLE_ASSETS,'USDT']);
    overview.USDT={price:1,change24h:0};
    res.json({markets:overview});
  }catch(e){res.status(502).json({error:'Market data unavailable'})}
});

// ===== Announcements =====
app.get('/api/announcements',auth,async(req,res)=>{
  const r=await q('SELECT id,title,body,created_at FROM announcements ORDER BY created_at DESC LIMIT 20');
  res.json({announcements:r.rows});
});
app.post('/api/admin/announcements',auth,requireAdmin,async(req,res)=>{
  try{
    const d=z.object({title:z.string().min(2).max(200),body:z.string().min(2).max(4000)}).parse(req.body);
    const r=await q('INSERT INTO announcements(title,body,created_by) VALUES($1,$2,$3) RETURNING *',[d.title,d.body,req.user.sub]);
    await q(`INSERT INTO audit_logs(user_id,action,metadata) VALUES($1,'announcement_posted',$2)`,[req.user.sub,JSON.stringify({title:d.title})]);
    res.status(201).json(r.rows[0]);
  }catch(e){res.status(400).json({error:e.message||'Invalid announcement'})}
});
app.delete('/api/admin/announcements/:id',auth,requireAdmin,async(req,res)=>{
  await q('DELETE FROM announcements WHERE id=$1',[req.params.id]);
  await q(`INSERT INTO audit_logs(user_id,action,metadata) VALUES($1,'announcement_deleted',$2)`,[req.user.sub,JSON.stringify({id:req.params.id})]);
  res.json({deleted:true});
});

// ===== Admin (real data, real access control — no more placeholder numbers) =====
app.get('/api/admin/overview',auth,requireAdmin,async(req,res)=>{
  const totalUsers=await q('SELECT count(*)::int AS c FROM users');
  const pendingKyc=await q(`SELECT count(*)::int AS c FROM users WHERE kyc_status NOT IN ('verified')`);
  const pendingWithdrawals=await q(`SELECT count(*)::int AS c, COALESCE(sum(amount),0) AS total FROM transactions WHERE type='withdrawal' AND status='pending'`);
  const riskAlerts=await q(`SELECT count(*)::int AS c FROM audit_logs WHERE action IN ('ai_trading_halted','withdrawal_failed') AND created_at > now() - interval '30 days'`);
  const queue=await q(`SELECT id,user_id,type,asset,amount,status,created_at FROM transactions WHERE status='pending' ORDER BY created_at DESC LIMIT 20`);
  const recentAudit=await q(`SELECT id,user_id,action,metadata,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 20`);
  res.json({
    totalUsers:totalUsers.rows[0].c,
    pendingKyc:pendingKyc.rows[0].c,
    pendingWithdrawals:{count:pendingWithdrawals.rows[0].c,total:pendingWithdrawals.rows[0].total},
    riskAlerts:riskAlerts.rows[0].c,
    queue:queue.rows,
    recentAudit:recentAudit.rows,
  });
});
app.post('/api/deposit/address',auth,async(req,res)=>{const d=schema.parse(req.body);const w=await q('SELECT * FROM wallets WHERE user_id=$1 AND asset=$2 AND network=$3',[req.user.sub,d.asset,d.network]);if(w.rows[0])return res.json(w.rows[0]);try{const a=await custody().createDepositAddress({...d,userId:req.user.sub});const r=await q('INSERT INTO wallets(user_id,asset,network,address,provider_ref) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.user.sub,d.asset,d.network,a.address,a.providerRef]);res.status(201).json(r.rows[0])}catch(e){console.error('Deposit address error:',e.message);if(String(e.message).startsWith('UNSUPPORTED_BY_PROVIDER'))return res.status(400).json({error:`${d.asset} deposits are not yet supported by the connected custody provider.`});res.status(502).json({error:'Could not create a deposit address right now.'})}});
app.post('/api/withdrawals',auth,async(req,res)=>{
  const d=schema.extend({amount:z.coerce.number().positive(),destinationAddress:z.string().min(10).max(200)}).parse(req.body);
  if(!assets.includes(d.asset))return res.status(400).json({error:'Unsupported asset'});
  const r=await q('SELECT available FROM balances WHERE user_id=$1 AND asset=$2 FOR UPDATE',[req.user.sub,d.asset]);
  const bal=Number(r.rows[0]?.available||0);
  if(bal<d.amount)return res.status(400).json({error:'Insufficient available balance'});
  const w=await q('SELECT * FROM wallets WHERE user_id=$1 AND asset=$2 AND network=$3',[req.user.sub,d.asset,d.network]);
  if(!w.rows[0])return res.status(400).json({error:'No source wallet on file for this asset/network yet — deposit first.'});
  await q('UPDATE balances SET available=available-$1,locked=locked+$1,updated_at=now() WHERE user_id=$2 AND asset=$3',[d.amount,req.user.sub,d.asset]);
  const tx=await q('INSERT INTO transactions(user_id,type,asset,network,amount,destination_address,status) VALUES($1,\'withdrawal\',$2,$3,$4,$5,\'pending\') RETURNING *',[req.user.sub,d.asset,d.network,d.amount,d.destinationAddress]);
  try{
    const result=await custody().createWithdrawal({asset:d.asset,network:d.network,amount:d.amount,destinationAddress:d.destinationAddress,fromAddress:w.rows[0].address,providerRef:w.rows[0].provider_ref});
    await q('UPDATE transactions SET status=$1,tx_hash=$2,provider_ref=$3,updated_at=now() WHERE id=$4',[result.status,result.txHash||null,result.providerRef||null,tx.rows[0].id]);
    await q('UPDATE balances SET locked=locked-$1,updated_at=now() WHERE user_id=$2 AND asset=$3',[d.amount,req.user.sub,d.asset]);
    await q(`INSERT INTO audit_logs(user_id,action,metadata) VALUES($1,'withdrawal_sent',$2)`,[req.user.sub,JSON.stringify({asset:d.asset,amount:d.amount,txHash:result.txHash})]);
    res.status(202).json({status:result.status,transaction:{...tx.rows[0],status:result.status,tx_hash:result.txHash},message:'Withdrawal submitted on testnet.'});
  }catch(e){
    console.error('Withdrawal execution error:',e.message);
    await q('UPDATE balances SET available=available+$1,locked=locked-$1,updated_at=now() WHERE user_id=$2 AND asset=$3',[d.amount,req.user.sub,d.asset]);
    await q('UPDATE transactions SET status=$1,updated_at=now() WHERE id=$2',['failed',tx.rows[0].id]);
    res.status(502).json({error:'Withdrawal could not be submitted. Your balance has been restored.'});
  }
});
const tradingSettingsSchema=z.object({
  autotrade_enabled:z.boolean().optional(),
  mode:z.enum(['paper','live']).optional(),
  watched_assets:z.array(z.enum(TRADABLE_ASSETS)).min(1).optional(),
  max_trade_pct:z.number().gt(0).max(25).optional(),
  max_daily_trades:z.number().int().positive().max(50).optional(),
  daily_loss_limit_pct:z.number().gt(0).max(25).optional(),
  min_confidence:z.number().min(0.5).max(0.70).optional(),
});

app.get('/api/trading/settings',auth,async(req,res)=>{
  const r=await q('SELECT * FROM trading_settings WHERE user_id=$1',[req.user.sub]);
  res.json(r.rows[0]||{autotrade_enabled:false,mode:'paper',watched_assets:TRADABLE_ASSETS,max_trade_pct:5,max_daily_trades:6,daily_loss_limit_pct:5,min_confidence:0.6});
});

app.put('/api/trading/settings',auth,async(req,res)=>{
  try{
    const d=tradingSettingsSchema.parse(req.body);
    const r=await q(
      `INSERT INTO trading_settings(user_id,autotrade_enabled,mode,watched_assets,max_trade_pct,max_daily_trades,daily_loss_limit_pct,min_confidence,halted_reason)
       VALUES($1,COALESCE($2,false),COALESCE($3,'paper'),COALESCE($4,ARRAY['BTC','ETH','SOL']),COALESCE($5,5),COALESCE($6,6),COALESCE($7,5),COALESCE($8,0.6),NULL)
       ON CONFLICT(user_id) DO UPDATE SET
         autotrade_enabled=COALESCE($2,trading_settings.autotrade_enabled),
         mode=COALESCE($3,trading_settings.mode),
         watched_assets=COALESCE($4,trading_settings.watched_assets),
         max_trade_pct=COALESCE($5,trading_settings.max_trade_pct),
         max_daily_trades=COALESCE($6,trading_settings.max_daily_trades),
         daily_loss_limit_pct=COALESCE($7,trading_settings.daily_loss_limit_pct),
         min_confidence=COALESCE($8,trading_settings.min_confidence),
         halted_reason=CASE WHEN $2=true THEN NULL ELSE trading_settings.halted_reason END,
         updated_at=now()
       RETURNING *`,
      [req.user.sub,d.autotrade_enabled,d.mode,d.watched_assets,d.max_trade_pct,d.max_daily_trades,d.daily_loss_limit_pct,d.min_confidence]
    );
    await q(`INSERT INTO audit_logs(user_id,action,metadata) VALUES($1,'trading_settings_updated',$2)`,[req.user.sub,JSON.stringify(d)]);
    res.json(r.rows[0]);
  }catch(e){res.status(400).json({error:e.message||'Invalid settings'})}
});

app.post('/api/trading/kill-switch',auth,async(req,res)=>{
  await q(`UPDATE trading_settings SET autotrade_enabled=false,halted_reason='Manually stopped by user',updated_at=now() WHERE user_id=$1`,[req.user.sub]);
  await q(`INSERT INTO audit_logs(user_id,action,metadata) VALUES($1,'ai_trading_killswitch',$2)`,[req.user.sub,'{}']);
  res.json({stopped:true});
});

app.get('/api/trading/decisions',auth,async(req,res)=>{
  const r=await q('SELECT * FROM ai_trade_decisions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',[req.user.sub]);
  res.json({decisions:r.rows});
});

app.get('/api/trading/signal/:asset',auth,async(req,res)=>{
  const asset=req.params.asset?.toUpperCase();
  if(!TRADABLE_ASSETS.includes(asset))return res.status(400).json({error:'Unsupported asset'});
  try{
    const history=await getPriceHistory(asset,60);
    const signal=generateSignal(history.map(p=>p.price));
    res.json({asset,...signal});
  }catch(e){res.status(502).json({error:'Market data unavailable'})}
});

app.post('/api/trading/run-cycle',async(req,res)=>{
  const secret=process.env.CRON_SECRET;
  if(!secret||req.headers['x-cron-secret']!==secret)return res.status(401).json({error:'Unauthorized'});
  try{const result=await runTradingCycle();res.json({ok:true,usersProcessed:result.usersProcessed,skipped:result.skipped||false})}
  catch(e){console.error('run-cycle endpoint error:',e.message);res.status(500).json({error:e.message})}
});

app.listen(process.env.PORT||4000,()=>{
  console.log('MindVenture API listening');
  if(process.env.RUN_SCHEDULER_IN_PROCESS==='true')startScheduler();
});
