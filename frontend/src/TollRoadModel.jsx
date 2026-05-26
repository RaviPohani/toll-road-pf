import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  AreaChart, Area, Legend, ComposedChart, CartesianGrid, ReferenceLine, Cell
} from 'recharts';

/* ============================================================
   TOLL ROAD PROJECT FINANCE MODEL v2 — US INFRASTRUCTURE
   v2: period framework (semi-annual/FY/CY/partial), full TIFIA,
   paygo, waterfall toggle w/ 1.0x overall obligation, optimizer.
   ============================================================ */

const REPAYMENT_STYLES = ['Sculpted (target DSCR)','Level debt service','Equal principal','Bullet','IO then amortize','Deferred P&I then sculpted','Phased (multi-regime)','Custom schedule'];
const PHASE_REGIMES = ['defer','io','sculpt','level','equal-principal'];
const INSTRUMENT_TYPES = ['TIFIA Loan','PABs (Private Activity Bonds)','CIBs (Current Interest Bonds)','CABs (Capital Appreciation Bonds)','Federal Grant','State Grant','Local Grant','RAN (Revenue Anticipation Note)','BAN (Bond Anticipation Note)','GAN (Grant Anticipation Note)','Bank Loan','Sponsor Equity','Paygo (Existing Net Revenues)'];
const SENIORITY = ['Senior','Subordinate','Short-term','Grant','Equity','Paygo'];
const CURVE_TYPES = ['Linear','S-curve','Front-loaded','Back-loaded','Custom'];
const DAY_COUNT = ['Actual/Actual','Actual/360','30/360'];
const WATERFALL_MODES = ['Opex-first (CFADS → DS)','Debt-first (Revenue → DS → Opex)'];

// ---------- DATE UTILS ----------
function parseDate(s){ if(!s) return new Date(Date.UTC(2026,6,1)); const [y,m,d]=s.split('-').map(Number); return new Date(Date.UTC(y,(m||1)-1,d||1)); }
function shortDate(d){ const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return `${m[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(2)}`; }
function addMonths(d,n){ const r=new Date(d); r.setUTCMonth(r.getUTCMonth()+n); return r; }
function daysBetween(a,b){ return Math.round((b-a)/(86400000)); }
function isLeap(y){ return (y%4===0&&y%100!==0)||(y%400===0); }
function dInYr(y){ return isLeap(y)?366:365; }
function dcfActAct(start,end){ let f=0; let cur=new Date(start); while(cur<end){ const y=cur.getUTCFullYear(); const yEnd=new Date(Date.UTC(y+1,0,1)); const c=end<yEnd?end:yEnd; f+=daysBetween(cur,c)/dInYr(y); cur=c; } return f; }
function dcfAct360(s,e){ return daysBetween(s,e)/360; }
function dcf30360(s,e){ const d1=Math.min(30,s.getUTCDate()); const d2=(d1===30)?Math.min(30,e.getUTCDate()):e.getUTCDate(); return (360*(e.getUTCFullYear()-s.getUTCFullYear())+30*(e.getUTCMonth()-s.getUTCMonth())+(d2-d1))/360; }
function dayCountFraction(s,e,conv){ if(conv==='Actual/360') return dcfAct360(s,e); if(conv==='30/360') return dcf30360(s,e); return dcfActAct(s,e); }

// ---------- DEFAULT MODEL ----------
const defaultModel = () => ({
  general: {
    projectName:'I-XXX Express Lanes', sponsor:'Concessionaire LLC', state:'Texas',
    financialCloseDate:'2026-07-01', constructionMonths:36, operationsYears:30,
    discountRate:0.07, periodsPerYear:2, useFiscalYear:false, fyStartMonth:7,
  },
  waterfall: { mode:'Opex-first (CFADS → DS)', overallObligationMin:1.00 },
  capex: {
    inflationDefault:0.025, curveDefault:'S-curve', useDirectForecast:false, directForecast:[],
    items: [
      {id:'eng',label:'D&B — Engineering',base:15_000_000,inflate:true,inflRate:0.025,curve:'S-curve',group:'D&B'},
      {id:'des',label:'D&B — Design',base:22_000_000,inflate:true,inflRate:0.025,curve:'S-curve',group:'D&B'},
      {id:'arc',label:'D&B — Architecture',base:8_000_000,inflate:true,inflRate:0.025,curve:'S-curve',group:'D&B'},
      {id:'mat',label:'D&B — Materials',base:240_000_000,inflate:true,inflRate:0.035,curve:'S-curve',group:'D&B'},
      {id:'lab',label:'D&B — Labor',base:180_000_000,inflate:true,inflRate:0.030,curve:'S-curve',group:'D&B'},
      {id:'uti',label:'D&B — Utilities',base:35_000_000,inflate:true,inflRate:0.025,curve:'Front-loaded',group:'D&B'},
      {id:'mob',label:'D&B — Mobilization',base:12_000_000,inflate:false,inflRate:0,curve:'Front-loaded',group:'D&B'},
      {id:'oth',label:'D&B — Other',base:18_000_000,inflate:true,inflRate:0.025,curve:'S-curve',group:'D&B'},
      {id:'spv',label:'SPV costs during construction',base:9_000_000,inflate:true,inflRate:0.025,curve:'Linear',group:'D&B'},
      {id:'row',label:'Right of Way (ROW)',base:45_000_000,inflate:true,inflRate:0.030,curve:'Front-loaded',group:'Other'},
      {id:'ure',label:'Utility Relocation',base:22_000_000,inflate:true,inflRate:0.025,curve:'Front-loaded',group:'Other'},
      {id:'env',label:'Environmental Clearance',base:6_500_000,inflate:false,inflRate:0,curve:'Front-loaded',group:'Other'},
      {id:'adv',label:'Advisory & Legal',base:11_000_000,inflate:false,inflRate:0,curve:'Linear',group:'Other'},
      {id:'res',label:'Reserve Deposits (initial)',base:28_000_000,inflate:false,inflRate:0,curve:'Back-loaded',group:'Other'},
    ],
  },
  paygo: { enabled:true, totalContribution:35_000_000, distributionCurve:'Linear', description:'Net existing toll revenues used as paygo during construction.' },
  revenue: {
    useDirectForecast:false, directForecast:[], inflate:true, tollEscalation:0.025,
    aadtY1:42_000, aadtRamp:[0.55,0.75,0.90,0.97,1.00],
    vehicleClasses:[
      {id:'c2',name:'Class 2 — Passenger',toll:2.50,share:0.78,growthRate:0.020},
      {id:'c3',name:'Class 3 — Light Truck',toll:5.00,share:0.12,growthRate:0.020},
      {id:'c4',name:'Class 4 — 3-axle Truck',toll:8.00,share:0.05,growthRate:0.015},
      {id:'c5',name:'Class 5 — 4-axle Truck',toll:11.00,share:0.03,growthRate:0.015},
      {id:'c6',name:'Class 6 — 5+ axle Truck',toll:15.00,share:0.02,growthRate:0.015},
    ], daysOpen:365,
  },
  opex: {
    useDirectForecast:false, directForecast:[], inflate:true, inflRate:0.025,
    items: [
      {id:'rom',label:'Roadway O&M',base:4_500_000},
      {id:'rmm',label:'Roadway Major Maintenance (annualized)',base:6_200_000},
      {id:'tom',label:'Tolling O&M',base:2_800_000},
      {id:'tmm',label:'Tolling Major Maintenance (annualized)',base:1_400_000},
      {id:'clp',label:'Toll Collection — License Plate ($/txn)',base:0.45,perTxn:true,share:0.35},
      {id:'cvi',label:'Toll Collection — Video/Tag ($/txn)',base:0.08,perTxn:true,share:0.65},
    ],
  },
  financing: {
    instruments: [
      {id:'eq1',type:'Sponsor Equity',amount:120_000_000,rate:0,tenorYears:30,closeDate:'2026-07-01',seniority:'Equity',repaymentStyle:'Sculpted (target DSCR)',drawdownPriority:5,targetDSCR:1.30,ioYears:0,deferralYears:0,dayCount:'30/360',covenants:'Distribution lockup if TIFIA lockup triggered', issuanceCost:0, issuanceCostEscalation:0},
      {id:'fg1',type:'Federal Grant',amount:60_000_000,rate:0,tenorYears:0,closeDate:'2026-07-01',seniority:'Grant',repaymentStyle:'Bullet',drawdownPriority:1,targetDSCR:0,ioYears:0,deferralYears:0,dayCount:'30/360',covenants:'Federal cost-share requirements', issuanceCost:250_000, issuanceCostEscalation:0.03},
      {id:'sg1',type:'State Grant',amount:40_000_000,rate:0,tenorYears:0,closeDate:'2026-07-01',seniority:'Grant',repaymentStyle:'Bullet',drawdownPriority:1,targetDSCR:0,ioYears:0,deferralYears:0,dayCount:'30/360',covenants:'State match requirements', issuanceCost:150_000, issuanceCostEscalation:0.03},
      {id:'pab1',type:'PABs (Private Activity Bonds)',amount:280_000_000,rate:0.0525,tenorYears:30,closeDate:'2026-07-01',seniority:'Senior',repaymentStyle:'Sculpted (target DSCR)',drawdownPriority:3,targetDSCR:1.35,ioYears:0,deferralYears:3,dayCount:'30/360',covenants:'Senior DSCR ≥1.20x; reserve fund equal to MADS', issuanceCost:4_500_000, issuanceCostEscalation:0.03},
      {id:'tifia1',type:'TIFIA Loan',amount:200_000_000,rate:0.0410,tenorYears:35,closeDate:'2026-07-01',seniority:'Subordinate',repaymentStyle:'Deferred P&I then sculpted',drawdownPriority:4,targetDSCR:1.10,ioYears:0,deferralYears:5,dayCount:'Actual/Actual',covenants:'TIFIA springing lien; sub DSCR ≥1.10x after deferral', issuanceCost:1_750_000, issuanceCostEscalation:0.03,
        phases:[
          {regime:'defer',           endPeriod:10, targetDSCR:null},
          {regime:'io',              endPeriod:20, targetDSCR:null},
          {regime:'sculpt',          endPeriod:60, targetDSCR:1.10},
          {regime:'level',           endPeriod:70, targetDSCR:null}
        ]},
      {id:'ran1',type:'RAN (Revenue Anticipation Note)',amount:50_000_000,rate:0.0350,tenorYears:2,closeDate:'2026-07-01',seniority:'Short-term',repaymentStyle:'Bullet',drawdownPriority:2,targetDSCR:0,ioYears:0,deferralYears:0,dayCount:'Actual/360',covenants:'Repaid from first revenues', issuanceCost:350_000, issuanceCostEscalation:0.03},
    ],
    financingFeesPctOfDebt:0.015, blendedIDCRateForNonTIFIA:0.0525,
    issuanceCostBaseYear:2024,
  },
  tifia: {
    instrumentId:'tifia1', treasuryRate:0.0395, spreadBps:1, useTenorSpreadCurve:true,
    tenorSpreadCurve:[{maxTenor:10,bps:0},{maxTenor:20,bps:1},{maxTenor:35,bps:1}],
    capInterestSemiAnnually:true, capPeriodMonths:6,
    fiftyPercentTestYearsBeforeMaturity:10, enforce50PctTest:true,
    minDSCR:1.10, minLLCR:1.30, minPLCR:1.40, maxWAL:25,
    lockupDSCR:1.20, lockupLLCR:1.20,
    adminFeeAnnual:13_500, monitoringFeeBps:7.5,
  },
  controlAccounts: {
    dsraMonthsDS:6, omReserveMonths:3, rampUpReserveAmount:15_000_000, rampUpReleaseYears:5,
    mmrTargetSchedule:[{yearStart:1,annualFunding:2_500_000},{yearStart:10,annualFunding:5_000_000},{yearStart:20,annualFunding:8_000_000}],
  },
  optimizer: {
    mode:'joint',
    targetInstrumentId:'pab1',
    constraints:{minSeniorDSCR:1.30,minTotalDSCR:1.10,minLLCR:1.30,minPLCR:1.40,enforceOverallObligation:true},
    jointTargets:[
      {instrumentId:'pab1', minDSCR:1.30, minLLCR:1.30},
      {instrumentId:'tifia1', minDSCR:1.10, minLLCR:1.20},
    ],
    plugInstrumentId:'eq1',
    cascade: {
      // TIFIA sizing
      tifiaInstrumentId:'tifia1',
      tifiaEligibleCapexIds:['eng','des','arc','mat','lab','uti','mob','oth','spv','row','ure'],
      tifiaPercentage:0.33,
      // PAB sizing
      pabInstrumentId:'pab1',
      pabTargetDSCR:1.30,
      // Equity sizing
      equityInstrumentId:'eq1',
      targetEquityIRR:0.12,
      // Plug
      plugInstrumentId:'eq1',
      // Auto-optimizer: when on, replaces manual tifiaPercentage with binary search
      autoOptimizeTifia: false,
      autoTifiaParams: {
        deferYears: 5,
        ioYears: 5,
        testYearsBeforeMaturity: 10,
        phase3Mode: 'annuity',
        minTifiaPct: 0.10,
        maxTifiaPct: 0.49,
        minTotalDSCR: 1.10,
        minSrDSCR: 1.30,
        minTifiaDSCR: 1.10,
      },
    },
    lastRun:null,
    lastJointRun:null,
    lastCascadeRun:null,
    lastAutoCascadeRun:null,
  },
  vfm: {
    pscDiscountRate: 0.045,
    pscCostPremium: 0.08,          // PSC delivery typically 5-15% more expensive (no private efficiency)
    competitiveNeutralityPct: 0.03, // adjustment for PSC's tax/regulatory advantage
    isAvailabilityBased: false,     // false = toll concession; true = availability payments
    upfrontConcessionFee: 50_000_000,
    revenueSharePct: 0.05,          // share of revenue P3 returns to public
    availabilityPaymentAnnual: 60_000_000,
    availabilityEscalation: 0.020,
    availabilityStartYear: 3,
    availabilityYears: 30,
    riskRegister: [
      // Construction risks — mitigationCost is ONE-TIME during construction
      {id:'rc1', category:'Construction Cost Overrun (D&B)',      phase:'construction', probability:0.40, impactLow:10_000_000, impactMostLikely:35_000_000, impactHigh:90_000_000, shareToPrivate:0.85, mitigationCost:3_000_000, mitigationOwner:'private', probReduction:0.25, impactReduction:0.20, notes:'Materials, labor, change orders'},
      {id:'rc2', category:'Construction Schedule Delay',          phase:'construction', probability:0.45, impactLow:5_000_000,  impactMostLikely:18_000_000, impactHigh:55_000_000, shareToPrivate:0.90, mitigationCost:2_000_000, mitigationOwner:'private', probReduction:0.30, impactReduction:0.25, notes:'Delay damages + carrying costs'},
      {id:'rc3', category:'ROW Acquisition',                       phase:'construction', probability:0.30, impactLow:3_000_000,  impactMostLikely:12_000_000, impactHigh:40_000_000, shareToPrivate:0.20, mitigationCost:1_500_000, mitigationOwner:'public',  probReduction:0.20, impactReduction:0.15, notes:'Early condemnation, parcel pre-clearance'},
      {id:'rc4', category:'Utility Relocation Overrun',            phase:'construction', probability:0.35, impactLow:2_000_000,  impactMostLikely:8_000_000,  impactHigh:25_000_000, shareToPrivate:0.50, mitigationCost:1_000_000, mitigationOwner:'shared',  probReduction:0.25, impactReduction:0.20, notes:'Early utility coordination meetings'},
      {id:'rc5', category:'Geotechnical / Site Conditions',        phase:'construction', probability:0.25, impactLow:4_000_000,  impactMostLikely:15_000_000, impactHigh:50_000_000, shareToPrivate:0.70, mitigationCost:2_500_000, mitigationOwner:'private', probReduction:0.30, impactReduction:0.25, notes:'Pre-bid geotech surveys + soil borings'},
      {id:'rc6', category:'Permitting / Environmental Delays',     phase:'construction', probability:0.20, impactLow:2_000_000,  impactMostLikely:10_000_000, impactHigh:35_000_000, shareToPrivate:0.30, mitigationCost:1_500_000, mitigationOwner:'public',  probReduction:0.40, impactReduction:0.30, notes:'NEPA pre-FEIS, early agency engagement'},
      // Operations risks — mitigationCost is ANNUAL during operations
      {id:'ro1', category:'Traffic Demand Shortfall',              phase:'operations',   probability:0.55, impactLow:-3_000_000, impactMostLikely:5_000_000,  impactHigh:18_000_000, shareToPrivate:0.95, mitigationCost:500_000,   mitigationOwner:'private', probReduction:0.15, impactReduction:0.20, notes:'Marketing + tolling promotions'},
      {id:'ro2', category:'O&M Cost Overrun',                      phase:'operations',   probability:0.40, impactLow:500_000,    impactMostLikely:2_000_000,  impactHigh:6_000_000,  shareToPrivate:0.85, mitigationCost:200_000,   mitigationOwner:'private', probReduction:0.30, impactReduction:0.25, notes:'Performance-based contracts'},
      {id:'ro3', category:'Major Maintenance Cost Overrun',        phase:'operations',   probability:0.50, impactLow:1_000_000,  impactMostLikely:4_000_000,  impactHigh:15_000_000, shareToPrivate:0.90, mitigationCost:400_000,   mitigationOwner:'private', probReduction:0.25, impactReduction:0.30, notes:'Lifecycle planning + predictive maintenance'},
      {id:'ro4', category:'Tolling Technology Obsolescence',       phase:'operations',   probability:0.30, impactLow:1_000_000,  impactMostLikely:3_000_000,  impactHigh:10_000_000, shareToPrivate:0.75, mitigationCost:300_000,   mitigationOwner:'private', probReduction:0.20, impactReduction:0.30, notes:'Tech refresh sinking fund'},
      {id:'ro5', category:'Force Majeure / Insurance Gap',         phase:'operations',   probability:0.15, impactLow:2_000_000,  impactMostLikely:8_000_000,  impactHigh:30_000_000, shareToPrivate:0.40, mitigationCost:600_000,   mitigationOwner:'shared',  probReduction:0.10, impactReduction:0.40, notes:'Catastrophe insurance premiums'},
      {id:'ro6', category:'Change in Law / Regulation',            phase:'operations',   probability:0.20, impactLow:500_000,    impactMostLikely:2_500_000,  impactHigh:12_000_000, shareToPrivate:0.20, mitigationCost:150_000,   mitigationOwner:'public',  probReduction:0.10, impactReduction:0.20, notes:'Legal monitoring + advocacy'},
    ],
  },
});

// ---------- FORMAT HELPERS ----------
const fmt$ = n => { if(n==null||isNaN(n)||!isFinite(n)) return '—'; const a=Math.abs(n); if(a>=1e9) return `${n<0?'(':''}$${(a/1e9).toFixed(2)}B${n<0?')':''}`; if(a>=1e6) return `${n<0?'(':''}$${(a/1e6).toFixed(2)}M${n<0?')':''}`; if(a>=1e3) return `${n<0?'(':''}$${(a/1e3).toFixed(1)}k${n<0?')':''}`; return `${n<0?'(':''}$${a.toFixed(0)}${n<0?')':''}`; };
const fmtPct = (n,d=2) => (n==null||isNaN(n)||!isFinite(n))?'—':`${(n*100).toFixed(d)}%`;
const fmtRatio = (n,d=2) => (n==null||isNaN(n)||!isFinite(n))?'—':`${n.toFixed(d)}x`;
const sum = a => a.reduce((x,y)=>x+(y||0),0);
const zeros = n => Array.from({length:n},()=>0);
const avg = a => a.length?sum(a)/a.length:0;

function distributeCurve(total, periods, curveType, custom=null){
  if(periods<=0) return [];
  if(curveType==='Custom' && Array.isArray(custom) && custom.length===periods){ const s=sum(custom)||1; return custom.map(v=>(v/s)*total); }
  const idx = Array.from({length:periods},(_,i)=>i);
  let w;
  if(curveType==='Linear') w = idx.map(()=>1);
  else if(curveType==='S-curve'){ const k=8/periods,m=(periods-1)/2; const cdf=idx.map(i=>1/(1+Math.exp(-k*(i-m)))); w=cdf.map((v,i)=>i===0?v:v-cdf[i-1]); }
  else if(curveType==='Front-loaded') w = idx.map(i=>Math.exp(-3*(i/Math.max(1,periods-1))));
  else if(curveType==='Back-loaded') w = idx.map(i=>Math.exp(3*(i/Math.max(1,periods-1))-3));
  else w = idx.map(()=>1);
  const ws = sum(w)||1;
  return w.map(x=>(x/ws)*total);
}
function inflateMonth(base, rate, monthIdx){ return base * Math.pow(1+rate, monthIdx/12); }

// ---------- PERIOD FRAMEWORK ----------
function generateOperatingPeriods(model){
  const finClose = parseDate(model.general.financialCloseDate);
  const opsStart = addMonths(finClose, model.general.constructionMonths);
  const opsEnd = addMonths(opsStart, model.general.operationsYears*12);
  const ppy = model.general.periodsPerYear || 2;
  const mpp = 12 / ppy;
  const yStart = model.general.useFiscalYear ? (model.general.fyStartMonth||7) : 1;
  const periods = [];
  let cursor = new Date(opsStart);
  let safety = 0;
  while(cursor < opsEnd && safety < 500){
    safety++;
    const cm = cursor.getUTCMonth()+1;
    let baseYear, monthsIn;
    if(cm >= yStart){ baseYear = cursor.getUTCFullYear(); monthsIn = cm - yStart; }
    else { baseYear = cursor.getUTCFullYear()-1; monthsIn = 12-yStart+cm; }
    const periodIdx = Math.floor(monthsIn / mpp);
    const fullStartAbsMonth = yStart-1 + periodIdx*mpp;
    const fullPeriodStart = new Date(Date.UTC(baseYear, fullStartAbsMonth, 1));
    const fullPeriodEnd = new Date(Date.UTC(baseYear, fullStartAbsMonth + mpp, 1));
    const periodEnd = fullPeriodEnd < opsEnd ? fullPeriodEnd : opsEnd;
    const days = daysBetween(cursor, periodEnd);
    const fullDays = daysBetween(fullPeriodStart, fullPeriodEnd);
    periods.push({
      idx: periods.length, start: new Date(cursor), end: new Date(periodEnd),
      days, fullDays,
      yearFraction: days / (isLeap(cursor.getUTCFullYear())?366:365),
      dayFraction: fullDays>0 ? days/fullDays : 1,
      isPartial: days < fullDays,
      label: `${shortDate(cursor)}–${shortDate(periodEnd)}`,
    });
    cursor = new Date(periodEnd);
  }
  return periods;
}

// ---------- CAPEX SCHEDULE ----------
function buildCapexSchedule(model){
  const months = model.general.constructionMonths;
  const result = { monthly: zeros(months), byItem: {}, totalNominal: 0, totalBase: 0 };
  if(model.capex.useDirectForecast && model.capex.directForecast.length){
    model.capex.directForecast.forEach(row=>{ const m=Math.max(0,Math.min(months-1,(row.month||1)-1)); result.monthly[m] += row.total||0; });
    result.totalNominal = sum(result.monthly); result.totalBase = result.totalNominal;
    result.byItem['direct'] = [...result.monthly]; return result;
  }
  model.capex.items.forEach(item=>{
    const baseDist = distributeCurve(item.base, months, item.curve, item.customCurve);
    const nominal = baseDist.map((v,i)=> item.inflate ? inflateMonth(v, item.inflRate, i) : v);
    result.byItem[item.id] = nominal;
    nominal.forEach((v,i)=>{ result.monthly[i] += v; });
    result.totalNominal += sum(nominal);
    result.totalBase += item.base;
  });
  return result;
}

// ---------- PAYGO ----------
function buildPaygoSchedule(model){
  const months = model.general.constructionMonths;
  if(!model.paygo.enabled) return { monthly: zeros(months), total: 0 };
  const dist = distributeCurve(model.paygo.totalContribution, months, model.paygo.distributionCurve);
  return { monthly: dist, total: sum(dist) };
}

// ---------- TIFIA CONSTRUCTION INTEREST (act/act, semi-annual cap) ----------
function buildTIFIAConstructionInterest(tifiaInst, tifiaMonthlyDraws, tifiaCfg, model){
  const finClose = parseDate(model.general.financialCloseDate);
  const months = tifiaMonthlyDraws.length;
  const capMonths = tifiaCfg.capPeriodMonths || 6;
  let balance = 0, accrued = 0;
  const monthlyInterest = zeros(months);
  const monthlyBalance = zeros(months);
  const capitalizations = [];
  for(let m=0; m<months; m++){
    const ms = addMonths(finClose, m);
    const me = addMonths(finClose, m+1);
    const dcf = dayCountFraction(ms, me, tifiaInst.dayCount || 'Actual/Actual');
    const intM = balance * tifiaInst.rate * dcf;
    accrued += intM;
    monthlyInterest[m] = intM;
    balance += tifiaMonthlyDraws[m] || 0;
    if((m+1) % capMonths === 0 || m === months-1){
      if(accrued > 0){
        balance += accrued;
        capitalizations.push({ monthIdx: m, amount: accrued });
        accrued = 0;
      }
    }
    monthlyBalance[m] = balance;
  }
  return { monthlyInterest, monthlyBalance, capitalizations,
    capitalizedInterestTotal: sum(capitalizations.map(c=>c.amount)),
    finalBalance: balance };
}

// ---------- TIFIA SPREAD ----------
function tifiaSpreadBps(tenor, cfg){
  if(!cfg.useTenorSpreadCurve) return cfg.spreadBps || 0;
  const sorted = [...(cfg.tenorSpreadCurve||[])].sort((a,b)=>a.maxTenor-b.maxTenor);
  for(const r of sorted) if(tenor <= r.maxTenor) return r.bps;
  return sorted.length ? sorted[sorted.length-1].bps : 0;
}
function tifiaAllInRate(tenor, cfg){ return (cfg.treasuryRate||0) + tifiaSpreadBps(tenor,cfg)/10000; }

// ---------- REVENUE (period framework) ----------
function buildRevenueSchedule(model, periods){
  const out = { byPeriod: zeros(periods.length), byClass: {}, aadtByPeriod: zeros(periods.length) };
  if(model.revenue.useDirectForecast && model.revenue.directForecast.length){
    const byYear = {};
    model.revenue.directForecast.forEach(row=>{ byYear[row.year-1] = row.total||0; });
    let cumY = 0;
    periods.forEach((p,i)=>{
      const y = Math.floor(cumY);
      out.byPeriod[i] = (byYear[y]||0) * p.yearFraction;
      cumY += p.yearFraction;
    });
    return out;
  }
  const r = model.revenue;
  let cumY = 0;
  periods.forEach((p,i)=>{
    const y = Math.floor(cumY);
    const rampIdx = Math.min(y, r.aadtRamp.length-1);
    let pr = 0, at = 0;
    r.vehicleClasses.forEach(c=>{
      const aadtC = r.aadtY1 * r.aadtRamp[rampIdx] * c.share * Math.pow(1+c.growthRate, y);
      const toll = r.inflate ? c.toll * Math.pow(1+r.tollEscalation, y) : c.toll;
      const annual = aadtC * toll * r.daysOpen;
      const pv = annual * p.yearFraction;
      pr += pv; at += aadtC;
      out.byClass[c.id] = out.byClass[c.id] || zeros(periods.length);
      out.byClass[c.id][i] = pv;
    });
    out.byPeriod[i] = pr;
    out.aadtByPeriod[i] = at;
    cumY += p.yearFraction;
  });
  return out;
}

// ---------- OPEX (period framework) ----------
function buildOpexSchedule(model, periods, revSched){
  const out = { byPeriod: zeros(periods.length), byItem: {} };
  if(model.opex.useDirectForecast && model.opex.directForecast.length){
    const byYear = {};
    model.opex.directForecast.forEach(row=>{ byYear[row.year-1] = row.total||0; });
    let cumY = 0;
    periods.forEach((p,i)=>{
      const y = Math.floor(cumY);
      out.byPeriod[i] = (byYear[y]||0) * p.yearFraction;
      cumY += p.yearFraction;
    });
    return out;
  }
  const rate = model.opex.inflRate;
  model.opex.items.forEach(it=>{ out.byItem[it.id] = zeros(periods.length); });
  let cumY = 0;
  periods.forEach((p,i)=>{
    const y = Math.floor(cumY);
    let pt = 0;
    model.opex.items.forEach(it=>{
      let ann;
      if(it.perTxn){
        const aadt = revSched.aadtByPeriod[i] || 0;
        const tx = aadt * 365 * (it.share||0);
        const cpt = model.opex.inflate ? it.base * Math.pow(1+rate, y) : it.base;
        ann = tx * cpt;
      } else {
        ann = model.opex.inflate ? it.base * Math.pow(1+rate, y) : it.base;
      }
      const pv = ann * p.yearFraction;
      out.byItem[it.id][i] = pv;
      pt += pv;
    });
    out.byPeriod[i] = pt;
    cumY += p.yearFraction;
  });
  return out;
}

// ---------- DEBT SCHEDULE PRIMITIVES ----------
function sculptToTarget(principal, ratePer, periods, cfads, target, ioP, defP){
  const n = periods.length;
  const interest = zeros(n), principalArr = zeros(n), balance = zeros(n);
  let bal = principal;
  for(let i=0;i<n;i++){
    const intP = bal * ratePer;
    if(i < defP){ bal += intP; balance[i] = bal; continue; }
    if(i < defP+ioP){ interest[i] = intP; balance[i] = bal; continue; }
    const maxDS = (cfads[i]||0) / Math.max(target, 0.0001);
    const pri = Math.max(0, Math.min(bal, maxDS - intP));
    interest[i] = intP; principalArr[i] = pri;
    bal -= pri; balance[i] = bal;
  }
  return { interest, principal: principalArr, balance };
}
function levelDebt(principal, ratePer, periods, ioP, defP){
  const n = periods.length;
  const interest = zeros(n), principalArr = zeros(n), balance = zeros(n);
  let bal = principal;
  for(let i=0;i<defP&&i<n;i++){ bal *= 1+ratePer; balance[i] = bal; }
  for(let i=defP;i<defP+ioP&&i<n;i++){ interest[i] = bal*ratePer; balance[i] = bal; }
  const amortStart = defP+ioP;
  const aP = Math.max(1, n-amortStart);
  const r = ratePer;
  const pmt = r>0 ? (bal*r)/(1-Math.pow(1+r,-aP)) : bal/aP;
  for(let i=amortStart;i<n;i++){
    const intP = bal*r;
    const pri = Math.min(bal, pmt-intP);
    interest[i] = intP; principalArr[i] = pri;
    bal -= pri; balance[i] = bal;
  }
  return { interest, principal: principalArr, balance };
}
function equalPrincipal(principal, ratePer, periods, ioP, defP){
  const n = periods.length;
  const interest = zeros(n), principalArr = zeros(n), balance = zeros(n);
  let bal = principal;
  for(let i=0;i<defP&&i<n;i++){ bal *= 1+ratePer; balance[i] = bal; }
  for(let i=defP;i<defP+ioP&&i<n;i++){ interest[i] = bal*ratePer; balance[i] = bal; }
  const amortStart = defP+ioP;
  const aP = Math.max(1, n-amortStart);
  const pri = bal/aP;
  for(let i=amortStart;i<n;i++){
    interest[i] = bal*ratePer;
    const p = Math.min(bal, pri);
    principalArr[i] = p; bal -= p; balance[i] = bal;
  }
  return { interest, principal: principalArr, balance };
}
function bullet(principal, ratePer, periods){
  const n = periods.length;
  const interest = zeros(n), principalArr = zeros(n), balance = zeros(n);
  let bal = principal;
  for(let i=0;i<n;i++){
    interest[i] = bal*ratePer;
    if(i===n-1){ principalArr[i] = bal; bal = 0; }
    balance[i] = bal;
  }
  return { interest, principal: principalArr, balance };
}

// ---------- PHASED (MULTI-REGIME) SCHEDULE ----------
// Walks an instrument through user-defined phases. Each phase has a regime (defer/io/sculpt/level/equal-principal)
// and an exclusive endPeriod (first period of next phase). Phase 0 starts at period 0.
// Regimes:
//   defer            — no payment; interest capitalizes into balance
//   io               — pay interest only; no principal
//   sculpt           — pay int + principal = CFADS_i / targetDSCR − int (bounded ≥0, ≤balance)
//   level            — compute level pmt at phase entry over phase duration; pay through phase
//   equal-principal  — equal principal across remaining periods of phase
// After the last phase's endPeriod, any residual balance bullets at maturity.
function phasedSchedule(principal, ratePer, periods, cfads, phases, originalPrincipal){
  const n = periods.length;
  const interest = zeros(n), principalArr = zeros(n), balance = zeros(n);
  let bal = principal;
  if(!phases || phases.length === 0) return bullet(principal, ratePer, periods);

  let phaseIdx = 0;
  let levelPmt = null;            // cached on entry to a level phase
  let equalPriPerPeriod = null;   // cached on entry to an equal-principal phase

  for(let i = 0; i < n; i++){
    // Advance through completed phases
    while(phaseIdx < phases.length && i >= (phases[phaseIdx].endPeriod || n)){
      phaseIdx++;
      levelPmt = null;
      equalPriPerPeriod = null;
    }

    if(phaseIdx >= phases.length){
      // Past last phase — accrue interest, bullet remaining at maturity
      interest[i] = bal * ratePer;
      if(i === n - 1){ principalArr[i] = bal; bal = 0; }
      balance[i] = bal;
      continue;
    }

    const phase = phases[phaseIdx];
    const intP = bal * ratePer;
    const phaseEnd = phase.endPeriod || n;
    const periodsRemainingInPhase = phaseEnd - i;

    if(phase.regime === 'defer'){
      // Interest capitalizes — no payment
      bal += intP;
      balance[i] = bal;
    }
    else if(phase.regime === 'io'){
      interest[i] = intP;
      balance[i] = bal;
    }
    else if(phase.regime === 'sculpt'){
      const tgt = phase.targetDSCR || 1.20;
      const maxDS = (cfads[i] || 0) / Math.max(tgt, 0.0001);
      const pri = Math.max(0, Math.min(bal, maxDS - intP));
      interest[i] = intP;
      principalArr[i] = pri;
      bal -= pri;
      balance[i] = bal;
    }
    else if(phase.regime === 'level'){
      if(levelPmt === null){
        // Compute level pmt ONCE at phase entry. If targetEndBalance specified, solve to that;
        // otherwise fully amortize to zero (default behavior).
        const r = ratePer;
        const n = periodsRemainingInPhase;
        const targetEnd = phase.targetEndBalance != null ? phase.targetEndBalance : 0;
        if(r > 0){
          const grow = Math.pow(1 + r, n);
          // bal*grow - pmt*(grow-1)/r = targetEnd  →  pmt = (bal*grow - targetEnd) * r / (grow-1)
          levelPmt = (bal * grow - targetEnd) * r / (grow - 1);
        } else {
          levelPmt = (bal - targetEnd) / Math.max(1, n);
        }
      }
      const pri = Math.max(0, Math.min(bal, levelPmt - intP));
      interest[i] = intP;
      principalArr[i] = pri;
      bal -= pri;
      balance[i] = bal;
    }
    else if(phase.regime === 'equal-principal'){
      if(equalPriPerPeriod === null){
        equalPriPerPeriod = bal / Math.max(1, periodsRemainingInPhase);
      }
      const pri = Math.min(bal, equalPriPerPeriod);
      interest[i] = intP;
      principalArr[i] = pri;
      bal -= pri;
      balance[i] = bal;
    }
    else {
      // Unknown regime — fallback to IO
      interest[i] = intP;
      balance[i] = bal;
    }
  }
  // Safety: ensure any residual balance bullets at maturity (matches level/bullet behavior).
  // Triggers if user-defined phases don't fully amortize within the actual slice (e.g. tenor capped by ops period).
  if(n > 0 && balance[n - 1] > 0){
    const extra = balance[n - 1];
    principalArr[n - 1] += extra;
    balance[n - 1] = 0;
  }
  return { interest, principal: principalArr, balance };
}

// ---------- 50% OUTSTANDING TEST ----------
// Helper: find the period index that is `yearsBeforeMat` before the last principal payment
function findTestIdx(sched, periods, yearsBeforeMat){
  const n = periods.length;
  let lastPriIdx = n-1;
  for(let i=n-1;i>=0;i--) if(sched.principal[i]>0){ lastPriIdx = i; break; }
  let testIdx = lastPriIdx;
  let remY = 0;
  for(let i=lastPriIdx;i>=0;i--){
    remY += periods[i].yearFraction;
    if(remY >= yearsBeforeMat){ testIdx = i; break; }
  }
  return testIdx;
}

// TRUE JOINT SOLVER: sculpt to target DSCR subject to 50% outstanding test.
// Binary-searches the highest effective DSCR target that still satisfies the 50% test.
// Lower DSCR target → larger DS budget per period → faster amortization → lower balance at test.
function sculptWithFiftyPctTest(principal, ratePer, periods, cfads, targetDSCR, ioP, defP, originalPrincipal, yearsBeforeMat, maxPct=0.5){
  const maxBal = originalPrincipal * maxPct;
  const natural = sculptToTarget(principal, ratePer, periods, cfads, targetDSCR, ioP, defP);
  const testIdx = findTestIdx(natural, periods, yearsBeforeMat);
  if(natural.balance[testIdx] <= maxBal + 1){
    return { schedule: natural, effectiveDSCR: targetDSCR, applied: false, testIdx,
      beforeBal: natural.balance[testIdx], maxAllowed: maxBal, naturalBalance: natural.balance[testIdx] };
  }
  // Sanity: even DSCR≈1.0 may not suffice if CFADS is too thin
  let lo = 1.0001, hi = targetDSCR;
  const sLo = sculptToTarget(principal, ratePer, periods, cfads, lo, ioP, defP);
  if(sLo.balance[testIdx] > maxBal){
    return { schedule: sLo, effectiveDSCR: lo, applied: true, testIdx,
      beforeBal: natural.balance[testIdx], maxAllowed: maxBal, naturalBalance: natural.balance[testIdx],
      infeasible: true };
  }
  let best = sLo, bestDSCR = lo;
  for(let iter=0; iter<40; iter++){
    const mid = (lo+hi)/2;
    const s = sculptToTarget(principal, ratePer, periods, cfads, mid, ioP, defP);
    if(s.balance[testIdx] <= maxBal){ best = s; bestDSCR = mid; lo = mid; }
    else hi = mid;
    if(Math.abs(hi-lo) < 0.001) break;
  }
  return { schedule: best, effectiveDSCR: bestDSCR, applied: true, testIdx,
    beforeBal: natural.balance[testIdx], maxAllowed: maxBal, naturalBalance: natural.balance[testIdx] };
}

// POST-HOC FIXER (for non-sculpted styles where the user still wants to enforce the test)
function apply50PctTest(sched, periods, originalPrincipal, yearsBeforeMat, maxPct=0.5){
  const n = periods.length;
  const testIdx = findTestIdx(sched, periods, yearsBeforeMat);
  const maxAllowed = originalPrincipal * maxPct;
  if(sched.balance[testIdx] <= maxAllowed){
    return { schedule: sched, applied: false, testIdx, beforeBal: sched.balance[testIdx], maxAllowed };
  }
  const shortfall = sched.balance[testIdx] - maxAllowed;
  const ns = { interest:[...sched.interest], principal:[...sched.principal], balance:[...sched.balance] };
  const priAfter = sum(ns.principal.slice(testIdx+1));
  if(priAfter <= 0) return { schedule: sched, applied: false, testIdx, beforeBal: sched.balance[testIdx], maxAllowed };
  const factor = Math.min(1, shortfall/priAfter);
  let moved = 0;
  for(let i=testIdx+1;i<n;i++){
    const red = ns.principal[i] * factor;
    ns.principal[i] -= red; moved += red;
  }
  const earlyP = Math.max(1, testIdx+1);
  const addPer = moved/earlyP;
  for(let i=0;i<=testIdx;i++) ns.principal[i] += addPer;
  let bal = originalPrincipal;
  for(let i=0;i<n;i++){
    if(sched.interest[i]===0 && sched.principal[i]===0 && i<10){
      bal = sched.balance[i]; ns.balance[i] = bal; ns.interest[i] = 0; ns.principal[i] = 0; continue;
    }
    const prevBal = i===0 ? bal : ns.balance[i-1];
    const implRate = prevBal>0 ? sched.interest[i]/prevBal : 0;
    ns.interest[i] = prevBal * implRate;
    ns.principal[i] = Math.min(prevBal, Math.max(0, ns.principal[i]));
    ns.balance[i] = prevBal - ns.principal[i];
    bal = ns.balance[i];
  }
  // Safety: bullet any residual at maturity (redistribution can leave residual when implied interest shifts)
  if(n > 0 && ns.balance[n-1] > 0){
    const extra = ns.balance[n-1];
    ns.principal[n-1] += extra;
    ns.balance[n-1] = 0;
  }
  return { schedule: ns, applied: true, testIdx, beforeBal: sched.balance[testIdx], maxAllowed, movedTotal: moved };
}

// LOCKUP ESCROW: accumulates trapped equity distributions during lockup periods.
// Releases full balance when conditions cure. Sweeps any residual at end of concession to equity.
function buildLockupAccount(rawEquityCF, lockup, periods){
  const n = periods.length;
  const balance = zeros(n), deposits = zeros(n), releases = zeros(n);
  const equityCFAfterLockup = zeros(n);
  let bal = 0;
  for(let i=0;i<n;i++){
    if(lockup[i]){
      if(rawEquityCF[i] > 0){
        deposits[i] = rawEquityCF[i];
        bal += rawEquityCF[i];
        equityCFAfterLockup[i] = 0;
      } else {
        equityCFAfterLockup[i] = rawEquityCF[i];
      }
    } else {
      const rel = bal;
      releases[i] = rel;
      bal = 0;
      equityCFAfterLockup[i] = rawEquityCF[i] + rel;
    }
    balance[i] = bal;
  }
  if(bal > 0 && n > 0){
    equityCFAfterLockup[n-1] += bal;
    releases[n-1] += bal;
    balance[n-1] = 0;
  }
  return { balance, deposits, releases, equityCFAfterLockup };
}

// ---------- INSTRUMENT SCHEDULE ----------
function buildInstrumentSchedule(inst, periods, cfads, tifiaCfg, ppy){
  const n = periods.length;
  if(['Grant','Equity','Paygo'].includes(inst.seniority)){
    return { interest: zeros(n), principal: zeros(n), balance: zeros(n) };
  }
  let effRate = inst.rate;
  if(inst.type === 'TIFIA Loan' && tifiaCfg) effRate = tifiaAllInRate(inst.tenorYears, tifiaCfg);
  const ratePer = effRate / ppy;
  const principal = inst.principalAfterIDC ?? inst.amount;
  const tenorP = Math.min(Math.round((inst.tenorYears || (n/ppy)) * ppy), n);
  const ioP = Math.round((inst.ioYears||0) * ppy);
  const defP = Math.round((inst.deferralYears||0) * ppy);
  const slice = periods.slice(0, tenorP);
  const isTIFIAwith50 = inst.type === 'TIFIA Loan' && tifiaCfg && tifiaCfg.enforce50PctTest;
  const isSculpted = inst.repaymentStyle === 'Sculpted (target DSCR)' || inst.repaymentStyle === 'Deferred P&I then sculpted';

  let s, testInfo = null, effectiveDSCR = null;
  if(isTIFIAwith50 && isSculpted){
    // TRUE JOINT SOLVE: sculpt-under-50%-test re-solver
    const ioForSculpt = inst.repaymentStyle === 'Deferred P&I then sculpted' ? 0 : ioP;
    const defForSculpt = inst.repaymentStyle === 'Deferred P&I then sculpted' ? Math.max(1, defP || ppy*3) : defP;
    const tgt = inst.repaymentStyle === 'Deferred P&I then sculpted' ? (inst.targetDSCR||1.20) : (inst.targetDSCR||1.30);
    const r = sculptWithFiftyPctTest(principal, ratePer, slice, cfads, tgt, ioForSculpt, defForSculpt, principal, tifiaCfg.fiftyPercentTestYearsBeforeMaturity||10, 0.5);
    s = r.schedule; testInfo = r; effectiveDSCR = r.effectiveDSCR;
  } else {
    if(inst.repaymentStyle === 'Level debt service') s = levelDebt(principal, ratePer, slice, ioP, defP);
    else if(inst.repaymentStyle === 'Equal principal') s = equalPrincipal(principal, ratePer, slice, ioP, defP);
    else if(inst.repaymentStyle === 'Bullet') s = bullet(principal, ratePer, slice);
    else if(inst.repaymentStyle === 'IO then amortize') s = levelDebt(principal, ratePer, slice, Math.max(1, ioP||ppy*5), defP);
    else if(inst.repaymentStyle === 'Deferred P&I then sculpted') s = sculptToTarget(principal, ratePer, slice, cfads, inst.targetDSCR||1.20, 0, Math.max(1, defP||ppy*3));
    else if(inst.repaymentStyle === 'Sculpted (target DSCR)') s = sculptToTarget(principal, ratePer, slice, cfads, inst.targetDSCR||1.30, ioP, defP);
    else if(inst.repaymentStyle === 'Phased (multi-regime)') s = phasedSchedule(principal, ratePer, slice, cfads, inst.phases||[], principal);
    else s = levelDebt(principal, ratePer, slice, ioP, defP);
    if(isTIFIAwith50 && inst.repaymentStyle !== 'Phased (multi-regime)'){
      // Phased schedules are assumed to be engineered (manually or by auto-cascade) to pass the 50% test.
      // Running the post-hoc redistributor on top creates spurious bullets that conflict with the phase structure.
      const r = apply50PctTest(s, slice, principal, tifiaCfg.fiftyPercentTestYearsBeforeMaturity||10, 0.5);
      s = r.schedule; testInfo = r;
    }
  }
  const pad = a => { const o = zeros(n); a.forEach((v,i)=>{ if(i<n) o[i] = v; }); return o; };
  return {
    interest: pad(s.interest), principal: pad(s.principal), balance: pad(s.balance),
    effectiveRate: effRate, fiftyPctTest: testInfo,
    targetDSCR: inst.targetDSCR, effectiveDSCR,
  };
}

// ---------- LLCR / PLCR / WAL ----------
function computeLLCR(cfads, balances, periods, discountRate, ppy){
  const n = periods.length;
  const ratePer = discountRate / ppy;
  const out = zeros(n);
  for(let i=0;i<n;i++){
    let npv = 0;
    for(let j=i+1;j<n;j++) npv += (cfads[j]||0) / Math.pow(1+ratePer, j-i);
    out[i] = balances[i] > 0 ? npv / balances[i] : null;
  }
  return out;
}
const computePLCR = computeLLCR;
function computeWAL(principalByPeriod, periods, originalPrincipal){
  let wt = 0, tot = 0, cum = 0;
  for(let i=0;i<principalByPeriod.length;i++){
    cum += periods[i].yearFraction;
    const mid = cum - periods[i].yearFraction/2;
    wt += mid * principalByPeriod[i];
    tot += principalByPeriod[i];
  }
  return tot > 0 ? wt/tot : null;
}

// ---------- CONTROL ACCOUNTS ----------
function buildControlAccounts(model, periods, ds, opex){
  const ca = model.controlAccounts;
  const n = periods.length;
  const ppy = model.general.periodsPerYear;
  const dsra = zeros(n), om = zeros(n), ramp = zeros(n), mmr = zeros(n);
  for(let i=0;i<n;i++){
    let nADS = 0, nAO = 0;
    for(let k=0;k<ppy && i+k<n;k++){ nADS += ds[i+k]||0; nAO += opex[i+k]||0; }
    dsra[i] = nADS * (ca.dsraMonthsDS/12);
    om[i] = nAO * (ca.omReserveMonths/12);
  }
  let rb = ca.rampUpReserveAmount;
  const relPer = ca.rampUpReserveAmount / Math.max(1, ca.rampUpReleaseYears * ppy);
  for(let i=0;i<n;i++){ rb = Math.max(0, rb-relPer); ramp[i] = rb; }
  let mb = 0, cumY = 0;
  for(let i=0;i<n;i++){
    cumY += periods[i].yearFraction;
    const y = Math.floor(cumY);
    let af = 0;
    const sched = ca.mmrTargetSchedule;
    for(let s=sched.length-1;s>=0;s--) if(y+1 >= sched[s].yearStart){ af = sched[s].annualFunding; break; }
    mb += af * periods[i].yearFraction;
    mmr[i] = mb;
  }
  return { dsraTarget: dsra, omTarget: om, rampUp: ramp, mmr };
}

// ---------- LOCKUP ----------
function checkLockup(seniorDSCR, llcr, tifiaCfg, periods){
  const out = zeros(periods.length);
  for(let i=0;i<periods.length;i++){
    const d = seniorDSCR[i] != null && seniorDSCR[i] < tifiaCfg.lockupDSCR;
    const l = llcr[i] != null && llcr[i] < tifiaCfg.lockupLLCR;
    out[i] = (d || l) ? 1 : 0;
  }
  return out;
}

// ---------- IRR ----------
function computeIRR(flows, guess=0.1){
  let r = guess;
  for(let it=0; it<200; it++){
    let npv = 0, dnpv = 0;
    for(let t=0;t<flows.length;t++){
      npv += flows[t] / Math.pow(1+r, t);
      dnpv += -t * flows[t] / Math.pow(1+r, t+1);
    }
    if(Math.abs(dnpv) < 1e-10) break;
    const nr = r - npv/dnpv;
    if(!isFinite(nr)) return null;
    if(Math.abs(nr-r) < 1e-7) return nr;
    r = nr < -0.99 ? -0.99 : (nr > 10 ? 10 : nr);
  }
  return r;
}

// ---------- FULL MODEL ASSEMBLER ----------
function buildFullModel(model){
  const ppy = model.general.periodsPerYear || 2;
  const capexSched = buildCapexSchedule(model);
  const cm = model.general.constructionMonths;
  const paygoSched = buildPaygoSchedule(model);
  const instruments = model.financing.instruments;
  const grantTotal = sum(instruments.filter(i=>i.seniority==='Grant').map(i=>i.amount));
  const equityTotal = sum(instruments.filter(i=>i.seniority==='Equity').map(i=>i.amount));
  const paygoTotal = paygoSched.total;
  const debtTotal = sum(instruments.filter(i=>!['Grant','Equity','Paygo'].includes(i.seniority)).map(i=>i.amount));
  const sourcesTotal = grantTotal + equityTotal + paygoTotal + debtTotal;
  const tifiaInst = instruments.find(i=>i.id===model.tifia.instrumentId && i.type==='TIFIA Loan');

  const debtMonthlyDraws = zeros(cm);
  const tifiaMonthlyDraws = zeros(cm);
  for(let m=0;m<cm;m++){
    const cM = capexSched.monthly[m];
    const equityShare = sourcesTotal>0 ? equityTotal/sourcesTotal : 0;
    const grantShare = sourcesTotal>0 ? grantTotal/sourcesTotal : 0;
    const paygoShare = sourcesTotal>0 ? paygoTotal/sourcesTotal : 0;
    const debtShare = 1 - equityShare - grantShare - paygoShare;
    const debtDraw = cM * debtShare;
    debtMonthlyDraws[m] = debtDraw;
    if(tifiaInst && debtTotal>0) tifiaMonthlyDraws[m] = debtDraw * (tifiaInst.amount/debtTotal);
  }
  const tifiaConstr = tifiaInst
    ? buildTIFIAConstructionInterest(tifiaInst, tifiaMonthlyDraws, model.tifia, model)
    : { monthlyInterest: zeros(cm), monthlyBalance: zeros(cm), capitalizations: [], capitalizedInterestTotal: 0, finalBalance: 0 };
  const nonTIFIADebt = debtTotal - (tifiaInst ? tifiaInst.amount : 0);
  const nonTIFIARate = model.financing.blendedIDCRateForNonTIFIA;
  let ntBal = 0, ntIDC = 0;
  const ntIDCMonthly = zeros(cm);
  for(let m=0;m<cm;m++){
    const i = ntBal * (nonTIFIARate/12);
    ntIDC += i; ntIDCMonthly[m] = i;
    const sh = debtTotal>0 ? nonTIFIADebt/debtTotal : 0;
    ntBal += debtMonthlyDraws[m] * sh;
  }
  const financingFees = debtTotal * model.financing.financingFeesPctOfDebt;
  if(tifiaInst) tifiaInst.principalAfterIDC = tifiaInst.amount + tifiaConstr.capitalizedInterestTotal;
  // Issuance costs per instrument, escalated from base year to FC year
  const baseYear = model.financing.issuanceCostBaseYear || 2024;
  const fcYear = parseInt((model.general.financialCloseDate || '2026-07-01').slice(0,4), 10);
  const yearsToFC = Math.max(0, fcYear - baseYear);
  const issuanceCostsByID = {};
  let totalIssuanceCost = 0;
  for(const inst of instruments){
    const base = inst.issuanceCost || 0;
    const esc = inst.issuanceCostEscalation || 0;
    const escalated = base > 0 ? base * Math.pow(1 + esc, yearsToFC) : 0;
    issuanceCostsByID[inst.id] = escalated;
    totalIssuanceCost += escalated;
  }
  const totalUses = capexSched.totalNominal + ntIDC + tifiaConstr.capitalizedInterestTotal + financingFees + totalIssuanceCost;

  const periods = generateOperatingPeriods(model);
  const n = periods.length;
  const revSched = buildRevenueSchedule(model, periods);
  const opexSched = buildOpexSchedule(model, periods, revSched);
  const cfads = zeros(n);
  for(let i=0;i<n;i++) cfads[i] = revSched.byPeriod[i] - opexSched.byPeriod[i];

  const order = { 'Short-term':0, 'Senior':1, 'Subordinate':2, 'Grant':3, 'Equity':4, 'Paygo':5 };
  const sortedInst = [...instruments].sort((a,b)=>(order[a.seniority]??99)-(order[b.seniority]??99));
  const debtSchedules = {};
  let remCFADS = [...cfads];
  sortedInst.forEach(inst=>{
    const s = buildInstrumentSchedule(inst, periods, remCFADS, model.tifia, ppy);
    debtSchedules[inst.id] = s;
    for(let i=0;i<n;i++) remCFADS[i] -= (s.interest[i] + s.principal[i]);
  });
  const seniorDS = zeros(n), subDS = zeros(n), shortDS = zeros(n);
  const seniorBal = zeros(n), subBal = zeros(n);
  const seniorInt = zeros(n), seniorPri = zeros(n);
  const subInt = zeros(n), subPri = zeros(n);
  sortedInst.forEach(inst=>{
    const s = debtSchedules[inst.id];
    for(let i=0;i<n;i++){
      const ds = s.interest[i] + s.principal[i];
      if(inst.seniority==='Senior'){ seniorDS[i] += ds; seniorBal[i] += s.balance[i]; seniorInt[i] += s.interest[i]; seniorPri[i] += s.principal[i]; }
      else if(inst.seniority==='Subordinate'){ subDS[i] += ds; subBal[i] += s.balance[i]; subInt[i] += s.interest[i]; subPri[i] += s.principal[i]; }
      else if(inst.seniority==='Short-term') shortDS[i] += ds;
    }
  });
  const totalDS = seniorDS.map((v,i)=>v + subDS[i] + shortDS[i]);
  // TIFIA admin + monitoring fees per period
  const tifiaAdminPerPeriod = zeros(n), tifiaMonitoringPerPeriod = zeros(n), tifiaFeesPerPeriod = zeros(n);
  if(tifiaInst){
    const adminYr = model.tifia.adminFeeAnnual || 0;
    const monBps = model.tifia.monitoringFeeBps || 0;
    const adminPer = adminYr / ppy;
    const tifiaBal = debtSchedules[tifiaInst.id]?.balance || zeros(n);
    for(let i=0;i<n;i++){
      tifiaAdminPerPeriod[i] = adminPer;
      tifiaMonitoringPerPeriod[i] = (tifiaBal[i] * (monBps/10000)) / ppy;
      tifiaFeesPerPeriod[i] = tifiaAdminPerPeriod[i] + tifiaMonitoringPerPeriod[i];
    }
  }
  const cfadsForDscr = cfads.map((c,i)=> c - tifiaFeesPerPeriod[i]);
  const totalTifiaFees = sum(tifiaFeesPerPeriod);
  const seniorDSCR = cfadsForDscr.map((c,i)=> seniorDS[i] > 0 ? c/seniorDS[i] : null);
  const totalDSCR = cfadsForDscr.map((c,i)=> totalDS[i] > 0 ? c/totalDS[i] : null);
  const overallObligation = revSched.byPeriod.map((r,i)=>(opexSched.byPeriod[i]+totalDS[i])>0 ? r/(opexSched.byPeriod[i]+totalDS[i]) : null);
  const overallPasses = overallObligation.map(v=>v!=null && v >= (model.waterfall.overallObligationMin||1.0));
  const llcrSenior = computeLLCR(cfads, seniorBal, periods, model.general.discountRate, ppy);
  const llcrTotal = computeLLCR(cfads, seniorBal.map((v,i)=>v+subBal[i]), periods, model.general.discountRate, ppy);
  const plcrSenior = computePLCR(cfads, seniorBal, periods, model.general.discountRate, ppy);
  const walByInstrument = {};
  sortedInst.forEach(inst=>{ walByInstrument[inst.id] = computeWAL(debtSchedules[inst.id].principal, periods, inst.principalAfterIDC ?? inst.amount); });
  const lockup = checkLockup(seniorDSCR, llcrSenior, model.tifia, periods);
  const controlAccts = buildControlAccounts(model, periods, totalDS, opexSched.byPeriod);
  // Raw equity CF before lockup trapping
  const rawEquityCF = zeros(n);
  for(let i=0;i<n;i++){
    if(model.waterfall.mode === 'Debt-first (Revenue → DS → Opex)'){
      rawEquityCF[i] = revSched.byPeriod[i] - totalDS[i] - opexSched.byPeriod[i] - tifiaFeesPerPeriod[i];
    } else {
      rawEquityCF[i] = cfadsForDscr[i] - totalDS[i];
    }
  }
  // Lockup escrow: traps positive equity CF during lockup; releases on cure
  const lockupAcct = buildLockupAccount(rawEquityCF, lockup, periods);
  const equityCF = lockupAcct.equityCFAfterLockup;
  const equityFlows = [-equityTotal - paygoTotal, ...equityCF];
  const equityIRR = computeIRR(equityFlows);
  const constrYears = Math.ceil(cm/12);
  const projFlows = zeros(constrYears).map((_,y)=>{
    const sM = y*12, eM = Math.min(cm, (y+1)*12);
    return -sum(capexSched.monthly.slice(sM, eM));
  });
  const annualCFADS = [];
  let cumY = 0, bucket = 0, bucketY = 0;
  for(let i=0;i<n;i++){
    bucket += cfads[i];
    cumY += periods[i].yearFraction;
    if(cumY >= bucketY+1 || i===n-1){ annualCFADS.push(bucket); bucket = 0; bucketY = Math.floor(cumY); }
  }
  const projectIRR = computeIRR([...projFlows, ...annualCFADS]);
  const finiteD = seniorDSCR.filter(v=>v!=null && isFinite(v));
  const finiteL = llcrSenior.filter(v=>v!=null && isFinite(v));
  return {
    periods, capexSched, paygoSched, tifiaConstr,
    nonTIFIAIDC: ntIDC, nonTIFIAIDCMonthly: ntIDCMonthly, financingFees,
    capitalizedTIFIAInterest: tifiaConstr.capitalizedInterestTotal,
    totalUses, totalSources: sourcesTotal, grantTotal, equityTotal, paygoTotal, debtTotal,
    totalIssuanceCost, issuanceCostsByID,
    tifiaAdminPerPeriod, tifiaMonitoringPerPeriod, tifiaFeesPerPeriod, totalTifiaFees,
    cfadsForDscr,
    revSched, opexSched, cfadsByPeriod: cfads,
    instruments: sortedInst, debtSchedules,
    seniorDS, subDS, shortDS, totalDS,
    seniorBal, subBal, seniorInt, seniorPri, subInt, subPri,
    seniorDSCR, totalDSCR, llcrSenior, llcrTotal, plcrSenior,
    walByInstrument, overallObligation, overallPasses,
    lockup, lockupAcct, rawEquityCF, controlAccts,
    equityCF, equityIRR, projectIRR,
    minSeniorDSCR: finiteD.length ? Math.min(...finiteD) : null,
    avgSeniorDSCR: finiteD.length ? avg(finiteD) : null,
    minLLCR: finiteL.length ? Math.min(...finiteL) : null,
    tifiaAllInRate: tifiaInst ? tifiaAllInRate(tifiaInst.tenorYears, model.tifia) : null,
    tifia50Test: tifiaInst && debtSchedules[tifiaInst.id] ? debtSchedules[tifiaInst.id].fiftyPctTest : null,
    tifiaEffectiveDSCR: tifiaInst && debtSchedules[tifiaInst.id] ? debtSchedules[tifiaInst.id].effectiveDSCR : null,
    tifiaTargetDSCR: tifiaInst ? tifiaInst.targetDSCR : null,
  };
}

// ---------- DEBT SIZING OPTIMIZER ----------
function optimizeInstrument(model, targetId, constraints){
  let lo = 1_000_000, hi = 2_000_000_000;
  let best = lo, bestResults = null;
  const check = (r) => {
    if(constraints.minSeniorDSCR && r.minSeniorDSCR != null && r.minSeniorDSCR < constraints.minSeniorDSCR) return false;
    if(constraints.minTotalDSCR){
      const f = r.totalDSCR.filter(v=>v!=null && isFinite(v));
      if(f.length && Math.min(...f) < constraints.minTotalDSCR) return false;
    }
    if(constraints.minLLCR && r.minLLCR != null && r.minLLCR < constraints.minLLCR) return false;
    if(constraints.minPLCR){
      const f = r.plcrSenior.filter(v=>v!=null && isFinite(v));
      if(f.length && Math.min(...f) < constraints.minPLCR) return false;
    }
    if(constraints.enforceOverallObligation && r.overallPasses.some(v=>v===false)) return false;
    return true;
  };
  const iterations = [];
  for(let iter=0; iter<40; iter++){
    const mid = (lo + hi) / 2;
    const m = JSON.parse(JSON.stringify(model));
    const target = m.financing.instruments.find(i=>i.id===targetId);
    if(!target) return { error: 'instrument not found' };
    target.amount = mid;
    const r = buildFullModel(m);
    const ok = check(r);
    iterations.push({ iter, amount: mid, ok, minDSCR: r.minSeniorDSCR, minLLCR: r.minLLCR });
    if(ok){ best = mid; bestResults = r; lo = mid; } else hi = mid;
    if(hi - lo < 100_000) break;
  }
  return { best, bestResults, iterations };
}

// JOINT MULTI-TRANCHE SIZING — ITERATIVE.
// Outer loop: size each tranche in seniority order, plug the gap, repeat until
// the funding gap stops changing or hits zero (which means the capital structure
// is internally consistent post-plug).
function optimizeJointTranches(model, targets, sharedConstraints, plugInstrumentId, maxOuterIter=5){
  let working = JSON.parse(JSON.stringify(model));
  const senOrder = { 'Senior':0, 'Subordinate':1, 'Short-term':2, 'Equity':3, 'Grant':4, 'Paygo':5 };
  const orderedTargets = [...targets].sort((a,b)=>{
    const ia = model.financing.instruments.find(i=>i.id===a.instrumentId);
    const ib = model.financing.instruments.find(i=>i.id===b.instrumentId);
    return (senOrder[ia?.seniority]??99) - (senOrder[ib?.seniority]??99);
  });
  const outerHistory = [];
  let converged = false;
  let prevGap = Infinity;
  let totalPlugAdj = 0;
  for(let outerIter=0; outerIter<maxOuterIter; outerIter++){
    const innerTraces = [];
    for(const tgt of orderedTargets){
      const inst = working.financing.instruments.find(i=>i.id===tgt.instrumentId);
      if(!inst){ innerTraces.push({instrumentId:tgt.instrumentId, error:'not found'}); continue; }
      const c = {
        ...sharedConstraints,
        minSeniorDSCR: inst.seniority==='Senior' ? (tgt.minDSCR ?? sharedConstraints.minSeniorDSCR) : sharedConstraints.minSeniorDSCR,
        minTotalDSCR: inst.seniority==='Subordinate' ? (tgt.minDSCR ?? sharedConstraints.minTotalDSCR) : sharedConstraints.minTotalDSCR,
        minLLCR: tgt.minLLCR ?? sharedConstraints.minLLCR,
      };
      const r = optimizeInstrument(working, tgt.instrumentId, c);
      if(r.best){
        const ins = working.financing.instruments.find(i=>i.id===tgt.instrumentId);
        ins.amount = Math.round(r.best);
      }
      innerTraces.push({instrumentId:tgt.instrumentId, seniority:inst.seniority, best:r.best, iterations:(r.iterations||[]).length});
    }
    // Plug
    const preR = buildFullModel(working);
    const gap = preR.totalUses - preR.totalSources;
    let plugAdj = 0;
    if(plugInstrumentId){
      const plugInst = working.financing.instruments.find(i=>i.id===plugInstrumentId);
      if(plugInst){
        const newAmt = Math.max(0, plugInst.amount + gap);
        plugAdj = newAmt - plugInst.amount;
        plugInst.amount = Math.round(newAmt);
        totalPlugAdj += plugAdj;
      }
    }
    const postR = buildFullModel(working);
    const postGap = postR.totalUses - postR.totalSources;
    outerHistory.push({outerIter:outerIter+1, innerTraces, preGap:gap, plugAdjustment:plugAdj, postGap, minSeniorDSCR:postR.minSeniorDSCR, minLLCR:postR.minLLCR});
    if(Math.abs(postGap) < 100_000){ converged = true; break; }
    if(outerIter > 0 && Math.abs(gap - prevGap) < 50_000){ converged = true; break; }
    prevGap = gap;
  }
  const finalResults = buildFullModel(working);
  const finalGap = finalResults.totalUses - finalResults.totalSources;
  const lastInner = outerHistory.length ? outerHistory[outerHistory.length-1].innerTraces : [];
  return {
    workingModel: working, outerHistory, finalResults, finalGap, converged,
    outerIterations: outerHistory.length, totalPlugAdjustment: totalPlugAdj,
    traces: lastInner.map(t=>({...t})),
    preGap: outerHistory[0]?.preGap, plugAdjustment: totalPlugAdj,
  };
}

// ============================================================
// CASCADE WATERFALL SIZING
// ============================================================
// Sequential cascade: TIFIA (% of eligible capex) → PAB (target DSCR) → Equity (target IRR) → Plug (gap).
// Iterates because TIFIA/PAB sizing shifts IDC, which shifts uses, which shifts the equity-IRR target.
// On each pass:
//   1. Compute TIFIA-eligible cost as sum of nominal capex from user-selected line items
//   2. TIFIA = eligibleCost × percentage (caps to 49% by statute typically)
//   3. PAB sized via binary search to target Senior DSCR (given new TIFIA)
//   4. Equity = NPV(residual equity CF stream @ target IRR), discounted from financial close
//   5. Plug = total uses − all other sources (positive = additional sponsor contribution; negative = surplus)
function runCascadeWaterfall(model, params, maxIter = 8){
  const working = JSON.parse(JSON.stringify(model));
  const trace = [];
  let prevPostGap = null;
  let converged = false;

  for(let outer = 0; outer < maxIter; outer++){
    // Build to get the capex schedule (used for TIFIA eligible cost)
    let stagedResults;
    try { stagedResults = buildFullModel(working); }
    catch(e){ return { error: 'Build failed at iter '+outer+': '+e.message, trace, workingModel:working }; }

    // 1. TIFIA-eligible cost = nominal capex of selected line items
    let eligibleCost = 0;
    for(const id of (params.tifiaEligibleCapexIds || [])){
      const monthly = stagedResults.capexSched.byItem[id] || [];
      eligibleCost += sum(monthly);
    }

    // 2. Size TIFIA
    const tifiaAmount = Math.round(eligibleCost * (params.tifiaPercentage || 0));
    const tifiaInst = working.financing.instruments.find(i => i.id === params.tifiaInstrumentId);
    if(tifiaInst) tifiaInst.amount = tifiaAmount;

    // 3. Size PAB to target Senior DSCR (binary search)
    let pabAmount = null, pabResult = null;
    if(params.pabInstrumentId){
      pabResult = optimizeInstrument(working, params.pabInstrumentId, {
        minSeniorDSCR: params.pabTargetDSCR,
      });
      if(pabResult && pabResult.best){
        pabAmount = Math.round(pabResult.best);
        const pabInst = working.financing.instruments.find(i => i.id === params.pabInstrumentId);
        if(pabInst) pabInst.amount = pabAmount;
      }
    }

    // 4. Equity from target IRR: NPV of residual equity CF at target IRR
    let preEquityResults;
    try { preEquityResults = buildFullModel(working); }
    catch(e){ return { error: 'Build failed before equity sizing: '+e.message, trace, workingModel:working }; }

    // Aggregate equity CF (post-lockup) to annual buckets
    const annualEqCF = [];
    const constYrs = Math.ceil(working.general.constructionMonths / 12);
    let bucketY = 0, cumY = 0, bucket = 0;
    for(let i = 0; i < preEquityResults.periods.length; i++){
      bucket += preEquityResults.equityCF[i];
      cumY += preEquityResults.periods[i].yearFraction;
      if(cumY >= bucketY + 1 || i === preEquityResults.periods.length - 1){
        annualEqCF.push(bucket);
        bucket = 0;
        bucketY = Math.floor(cumY);
      }
    }
    // NPV @ target IRR, discounted to t=0 (financial close), mid-year for each ops year
    let equityNPV = 0;
    for(let y = 0; y < annualEqCF.length; y++){
      const t = constYrs + y + 0.5;
      equityNPV += annualEqCF[y] / Math.pow(1 + (params.targetEquityIRR || 0.10), t);
    }
    const equityFromIRR = Math.max(0, Math.round(equityNPV));
    const equityInst = working.financing.instruments.find(i => i.id === params.equityInstrumentId);
    if(equityInst) equityInst.amount = equityFromIRR;

    // 5. Plug — fill or absorb funding gap
    let preGapResults;
    try { preGapResults = buildFullModel(working); }
    catch(e){ return { error: 'Build failed before plug: '+e.message, trace, workingModel:working }; }
    const gap = preGapResults.totalUses - preGapResults.totalSources;
    let plugAmount = 0;
    if(params.plugInstrumentId){
      const plugInst = working.financing.instruments.find(i => i.id === params.plugInstrumentId);
      if(plugInst){
        if(params.plugInstrumentId === params.equityInstrumentId){
          // Plug rides on top of the IRR-sized equity; resulting IRR will dilute below target
          plugInst.amount = Math.max(0, Math.round(equityFromIRR + gap));
          plugAmount = gap;
        } else {
          const newAmt = Math.max(0, Math.round(plugInst.amount + gap));
          plugAmount = newAmt - plugInst.amount;
          plugInst.amount = newAmt;
        }
      }
    }

    // Final check for this iteration
    let postResults;
    try { postResults = buildFullModel(working); }
    catch(e){ return { error: 'Build failed after plug: '+e.message, trace, workingModel:working }; }
    const postGap = postResults.totalUses - postResults.totalSources;

    trace.push({
      outer: outer + 1,
      eligibleCost, tifiaAmount, pabAmount, equityFromIRR,
      gap, plugAmount, postGap,
      actualEquityIRR: postResults.equityIRR,
      minSrDSCR: postResults.minSeniorDSCR,
      minLLCR: postResults.minLLCR,
      totalEquity: equityInst ? equityInst.amount : 0,
    });

    if(Math.abs(postGap) < 100_000){ converged = true; break; }
    if(prevPostGap !== null && Math.abs(postGap - prevPostGap) < 100_000){ converged = true; break; }
    prevPostGap = postGap;
  }

  let finalResults = null;
  try { finalResults = buildFullModel(working); } catch(e){}
  return {
    workingModel: working, trace, finalResults, converged,
    outerIterations: trace.length,
    finalGap: trace.length > 0 ? trace[trace.length - 1].postGap : 0,
  };
}

// ============================================================
// AUTO-CASCADE TIFIA (50% TEST PASSES BY CONSTRUCTION)
// ============================================================
// Generates a 4-phase TIFIA schedule (defer / IO / sculpt or annuity / level) such that:
//   - Phase 3 ends with balance = exactly 50% of original principal (test passes by construction)
//   - Phase 4 amortizes 50% to zero by maturity (annuity / level)
// Phase 3 mode:
//   'annuity' — level pmt sized to land at 50% balance at test point
//   'sculpt'  — binary-search DSCR target so balance at test = 50% (falls back to annuity if CFADS insufficient)
function buildTifiaCascadePhases(model, instrumentId, params, cfadsByPeriod){
  const inst = model.financing.instruments.find(i => i.id === instrumentId);
  if(!inst) return { error: 'TIFIA instrument not found', phases: [] };
  const ppy = model.general.periodsPerYear;
  const tenorPeriods = Math.round(inst.tenorYears * ppy);
  const deferP = Math.round((params.deferYears || 0) * ppy);
  const ioP = Math.round((params.ioYears || 0) * ppy);
  const testP = Math.round((params.testYearsBeforeMaturity || 10) * ppy);
  const phase3EndP = tenorPeriods - testP;
  const phase4EndP = tenorPeriods;
  const phase3Periods = phase3EndP - deferP - ioP;
  if(phase3Periods <= 0) return { error: 'Phase 3 has no periods (check defer/IO/test years vs tenor)', phases: [] };

  const P = inst.amount;
  const ratePer = tifiaAllInRate(inst.tenorYears, model.tifia) / ppy;
  // During defer interest capitalizes; IO is flat. Balance at end of IO = P * (1+r)^deferP
  const postIOBal = P * Math.pow(1 + ratePer, deferP);
  const targetTestBal = 0.5 * P;

  const phases = [];
  if(deferP > 0) phases.push({regime:'defer', endPeriod: deferP});
  if(ioP > 0)    phases.push({regime:'io',    endPeriod: deferP + ioP});

  let fallbackUsed = false;
  let foundDSCR = null;
  let diagnosis = '';

  if(params.phase3Mode === 'annuity' || params.phase3Mode === 'level'){
    phases.push({regime:'level', endPeriod: phase3EndP, targetEndBalance: targetTestBal});
    diagnosis = 'Phase 3 annuity (level pmt to 50% balance)';
  } else {
    // Sculpt mode — binary search DSCR
    const cfadsSlice = [];
    for(let i = deferP + ioP; i < phase3EndP; i++){
      cfadsSlice.push((cfadsByPeriod && cfadsByPeriod[i]) || 0);
    }
    const simulate = (dscr) => {
      let bal = postIOBal;
      for(let i = 0; i < cfadsSlice.length; i++){
        const intP = bal * ratePer;
        const maxDS = cfadsSlice[i] / Math.max(dscr, 0.0001);
        const pri = Math.max(0, Math.min(bal, maxDS - intP));
        bal -= pri;
      }
      return bal;
    };
    const balMaxAmort = simulate(1.0001);  // most amortization → lowest end balance
    if(balMaxAmort > targetTestBal){
      // Even maxing out principal can't bring balance to 50% — TIFIA too large for CFADS profile
      phases.push({regime:'level', endPeriod: phase3EndP, targetEndBalance: targetTestBal, _fallback:'sculpt-infeasible'});
      fallbackUsed = true;
      diagnosis = `Sculpt infeasible (TIFIA too large for CFADS) — fell back to annuity. Required end balance ${fmt$ ? fmt$(targetTestBal) : targetTestBal}, max amort gets to ${fmt$ ? fmt$(balMaxAmort) : balMaxAmort}.`;
    } else {
      let lo = 1.0001, hi = 200;
      for(let it = 0; it < 60; it++){
        const mid = (lo + hi) / 2;
        const bal = simulate(mid);
        if(bal > targetTestBal) hi = mid;
        else lo = mid;
        if(hi - lo < 0.0005) break;
      }
      foundDSCR = (lo + hi) / 2;
      phases.push({regime:'sculpt', endPeriod: phase3EndP, targetDSCR: foundDSCR});
      diagnosis = `Phase 3 sculpt @ DSCR ${foundDSCR.toFixed(3)}x (solved to hit 50% test balance)`;
    }
  }

  // Phase 4: level to zero
  phases.push({regime:'level', endPeriod: phase4EndP, targetEndBalance: 0});

  return {
    phases, testPoint: phase3EndP - 1,
    postIOBalance: postIOBal, targetTestBalance: targetTestBal,
    fallbackUsed, foundDSCR, diagnosis,
    phaseStructure: {
      defer: {start: 0, end: deferP, years: params.deferYears || 0},
      io: {start: deferP, end: deferP + ioP, years: params.ioYears || 0},
      phase3: {start: deferP + ioP, end: phase3EndP, years: phase3Periods/ppy, mode: params.phase3Mode || 'sculpt'},
      phase4: {start: phase3EndP, end: phase4EndP, years: (phase4EndP - phase3EndP)/ppy},
    },
  };
}

// Outer: binary-search TIFIA % such that all constraints satisfied (50% test passes by construction)

// TIFIA-FIRST cascade optimizer. Logic:
//   1. TIFIA = min(49% × eligible, max where 50% test passes + min Total DSCR ≥ floor + TIFIA eff DSCR ≥ floor)
//   2. PAB = min(remaining funding need, max where (CFADS_net − TIFIA DS) / Sr DS ≥ Sr DSCR floor)
//   3. Equity = set externally (NPV @ IRR target)
//   4. Grant = plug
// CFADS_net = CFADS - TIFIA admin/monitoring fees.
function autoCascadeTifia(model, params){
  const working = JSON.parse(JSON.stringify(model));
  const trace = [];

  const evaluate = (pct) => {
    const w = JSON.parse(JSON.stringify(working));
    let tempR;
    try { tempR = buildFullModel(w); }
    catch(e){ return { pct, error:'init build failed: '+e.message, feasible:false }; }

    // STEP 1: SIZE TIFIA
    let eligibleCost = 0;
    for(const id of (params.tifiaEligibleCapexIds || [])){
      eligibleCost += sum(tempR.capexSched.byItem[id] || []);
    }
    const tifiaAmount = Math.round(eligibleCost * pct);
    const tifia = w.financing.instruments.find(i => i.id === params.tifiaInstrumentId);
    if(!tifia) return { pct, error:'TIFIA not found', feasible:false };
    tifia.amount = tifiaAmount;

    // Zero PAB so TIFIA gets first shot
    const pabInst = params.pabInstrumentId
      ? w.financing.instruments.find(i => i.id === params.pabInstrumentId) : null;
    if(pabInst) pabInst.amount = 0;

    let preR;
    try { preR = buildFullModel(w); }
    catch(e){ return { pct, tifiaAmount, error:'pre-build failed: '+e.message, feasible:false }; }

    // CFADS available to TIFIA = cfadsForDscr (already net of TIFIA fees) since PAB=0
    const cfadsForTifia = preR.cfadsForDscr ? [...preR.cfadsForDscr] : [...preR.cfadsByPeriod];

    const phaseRes = buildTifiaCascadePhases(w, params.tifiaInstrumentId, {
      deferYears: params.deferYears, ioYears: params.ioYears,
      testYearsBeforeMaturity: params.testYearsBeforeMaturity,
      phase3Mode: params.phase3Mode,
    }, cfadsForTifia);
    if(phaseRes.error) return { pct, tifiaAmount, error: phaseRes.error, feasible:false };
    tifia.phases = phaseRes.phases;
    tifia.repaymentStyle = 'Phased (multi-regime)';

    // STEP 2: SIZE PAB
    // PAB only if TIFIA hit statutory ceiling AND funding gap remains.
    // PAB = min(funding gap, max where (CFADS - TIFIA DS)/Sr DS >= Sr DSCR floor)
    let pabAmount = 0;
    const maxTifiaPct = params.maxTifiaPct || 0.49;
    const tifiaAtCeiling = pct >= maxTifiaPct - 0.005;
    if(pabInst){
      if(!tifiaAtCeiling){
        // TIFIA stopped below ceiling — adding PAB hurts Total DSCR
        pabInst.amount = 0;
        pabAmount = 0;
      } else {
        // TIFIA at ceiling — check funding gap with PAB=0
        pabInst.amount = 0;
        let gapR;
        try { gapR = buildFullModel(w); } catch(e){ gapR = preR; }
        const fundingGap = gapR.totalUses - gapR.totalSources;
        if(fundingGap <= 0){
          pabAmount = 0;
        } else {
          const tifiaSched = gapR.debtSchedules?.[tifia.id] || {interest:[], principal:[]};
          const tifiaDS = gapR.periods.map((_, i) =>
            (tifiaSched.interest?.[i] || 0) + (tifiaSched.principal?.[i] || 0));
          const minSrFloor = params.minSrDSCR || 1.30;

          const pabFeasible = (amt) => {
            pabInst.amount = Math.round(amt);
            let rr;
            try { rr = buildFullModel(w); } catch(e){ return [false, null]; }
            let worst = Infinity;
            for(let j=0; j<rr.periods.length; j++){
              if(tifiaDS[j] > 1000 && (rr.seniorDS[j] || 0) > 1000){
                const d = ((rr.cfadsForDscr?.[j] || rr.cfadsByPeriod[j]) - tifiaDS[j]) / rr.seniorDS[j];
                if(d < worst) worst = d;
              }
            }
            if(!isFinite(worst)) worst = 999;
            return [worst >= minSrFloor - 0.005, worst];
          };

          let lo = 0, hi = fundingGap * 1.1;
          let maxAtFloor = 0;
          for(let k=0; k<40; k++){
            const m = (lo + hi) / 2;
            const [ok] = pabFeasible(m);
            if(ok){ maxAtFloor = m; lo = m; } else { hi = m; }
            if(hi - lo < 50_000) break;
          }
          pabAmount = Math.min(fundingGap, maxAtFloor);
          pabInst.amount = Math.round(pabAmount);
        }
      }
    }

    // STEP 4: PLUG
    let finalR;
    try { finalR = buildFullModel(w); }
    catch(e){ return { pct, tifiaAmount, error:'final build failed: '+e.message, feasible:false }; }
    let plugApplied = 0;
    if(params.plugInstrumentId){
      const gap = finalR.totalUses - finalR.totalSources;
      const plug = w.financing.instruments.find(i => i.id === params.plugInstrumentId);
      if(plug){
        plug.amount = Math.max(0, Math.round(plug.amount + gap));
        plugApplied = gap;
        try { finalR = buildFullModel(w); } catch(e){}
      }
    }

    // FEASIBILITY (floors measured over TIFIA-active periods; display falls back to all-period min)
    const tifiaSchedF = finalR.debtSchedules?.[params.tifiaInstrumentId];
    let minSrFeas = Infinity, minTotalDSCR = Infinity, minTifiaEffDSCR = Infinity;
    if(tifiaSchedF){
      for(let i=0; i<finalR.periods.length; i++){
        const tDS = (tifiaSchedF.interest[i]||0) + (tifiaSchedF.principal[i]||0);
        if(tDS > 1000){
          const srDSi = finalR.seniorDS[i] || 0;
          const subDSi = finalR.subDS?.[i] || 0;
          const cfi = finalR.cfadsForDscr?.[i] || finalR.cfadsByPeriod[i] || 0;
          if(srDSi > 1000){
            const sd = cfi / srDSi;
            if(sd < minSrFeas) minSrFeas = sd;
          }
          const td = srDSi + subDSi;
          if(td > 1000){
            const ttd = cfi / td;
            if(ttd < minTotalDSCR) minTotalDSCR = ttd;
          }
          const eff = (cfi - srDSi) / tDS;
          if(eff < minTifiaEffDSCR) minTifiaEffDSCR = eff;
        }
      }
    }
    // Display: prefer TIFIA-active value, fall back to all-period min
    let minSrDSCR;
    if(isFinite(minSrFeas)) minSrDSCR = minSrFeas;
    else {
      const allSr = (finalR.seniorDSCR || []).filter(v => v != null && isFinite(v));
      minSrDSCR = allSr.length ? Math.min(...allSr) : 999;
    }
    if(!isFinite(minTotalDSCR)) minTotalDSCR = null;
    if(!isFinite(minTifiaEffDSCR)) minTifiaEffDSCR = null;
    const srForFeas = isFinite(minSrFeas) ? minSrFeas : 999;

    const testBalAtPoint = (phaseRes.testPoint >= 0 && tifiaSchedF) ? tifiaSchedF.balance[phaseRes.testPoint] : null;
    const testPassed = testBalAtPoint != null && testBalAtPoint <= 0.5 * tifiaAmount + 1000;

    const feasible = (
      (minTotalDSCR == null || minTotalDSCR >= (params.minTotalDSCR || 1.10) - 0.005)
      && (minTifiaEffDSCR == null || minTifiaEffDSCR >= (params.minTifiaDSCR || 1.10) - 0.005)
      && (srForFeas >= (params.minSrDSCR || 1.30) - 0.005)
      && testPassed
    );

    return {
      pct, tifiaAmount, pabAmount: Math.round(pabAmount), eligibleCost,
      phaseInfo: phaseRes,
      minSrDSCR, minTotalDSCR, minTifiaEffDSCR,
      testBalAtPoint, testPassed,
      finalGap: finalR.totalUses - finalR.totalSources, plugApplied,
      feasible, workingModel: w, finalResults: finalR,
    };
  };

  let lo = params.minTifiaPct || 0.10;
  let hi = params.maxTifiaPct || 0.49;
  let best = null;

  const eHi = evaluate(hi);
  trace.push({...eHi, iter:1});
  if(eHi.feasible){
    return { best: eHi, trace, converged: true, ceilingReached: true };
  }
  const eLo = evaluate(lo);
  trace.push({...eLo, iter:2});
  if(!eLo.feasible){
    return { best: null, trace, converged: false, error:'Even min TIFIA % infeasible — relax constraints' };
  }
  best = eLo;

  for(let it=0; it<18; it++){
    const mid = (lo + hi) / 2;
    const r = evaluate(mid);
    trace.push({...r, iter: trace.length + 1});
    if(r.feasible){ best = r; lo = mid; }
    else hi = mid;
    if(hi - lo < 0.003) break;
  }
  return { best, trace, converged: true };
}

// ============================================================
// VALUE FOR MONEY (VfM) ANALYSIS
// ============================================================
// Quantifies the cost of P3 delivery vs the Public Sector Comparator (PSC).
// PSC bears 100% of risks (no contractual transfer); P3 bears the contractually transferred share.
// Both NPVs are taken from the public sector's perspective at the PSC (government) discount rate.

function computeRiskExpectedImpact(risk){
  // PERT mean — robust against optimistic/pessimistic tail bias
  return ((risk.impactLow || 0) + 4 * (risk.impactMostLikely || 0) + (risk.impactHigh || 0)) / 6;
}

function npvAnnuity(annual, years, rate, startDelayYears = 0){
  if(years <= 0) return 0;
  const pv = rate === 0 ? annual * years : annual * (1 - Math.pow(1 + rate, -years)) / rate;
  return pv / Math.pow(1 + rate, startDelayYears);
}

function buildVfMAnalysis(model, results){
  const v = model.vfm;
  const rate = v.pscDiscountRate || 0.045;
  const constYrs = Math.ceil(model.general.constructionMonths / 12);
  const opsYrs = model.general.operationsYears;

  // Aggregate capex by construction year (mid-year discounting)
  const annualCapex = [];
  for(let y = 0; y < constYrs; y++){
    const sM = y * 12, eM = Math.min(model.general.constructionMonths, (y + 1) * 12);
    annualCapex.push(sum(results.capexSched.monthly.slice(sM, eM)));
  }
  // Aggregate ops opex and revenue by ops year
  const annualOpex = [], annualRevenue = [];
  let bucketY = 0, cumY = 0, bucketOpex = 0, bucketRev = 0;
  for(let i = 0; i < results.periods.length; i++){
    bucketOpex += results.opexSched.byPeriod[i];
    bucketRev  += results.revSched.byPeriod[i];
    cumY += results.periods[i].yearFraction;
    if(cumY >= bucketY + 1 || i === results.periods.length - 1){
      annualOpex.push(bucketOpex);
      annualRevenue.push(bucketRev);
      bucketOpex = 0; bucketRev = 0;
      bucketY = Math.floor(cumY);
    }
  }

  // Risk evaluation — with mitigation
  const constrRisks = v.riskRegister.filter(r => r.phase === 'construction');
  const opsRisks    = v.riskRegister.filter(r => r.phase === 'operations');
  const enrich = r => {
    const pertPre = computeRiskExpectedImpact(r);
    const evPre = (r.probability || 0) * pertPre;
    const pR = r.probReduction || 0, iR = r.impactReduction || 0;
    const postR = { ...r,
      probability: (r.probability || 0) * (1 - pR),
      impactLow: (r.impactLow || 0) * (1 - iR),
      impactMostLikely: (r.impactMostLikely || 0) * (1 - iR),
      impactHigh: (r.impactHigh || 0) * (1 - iR),
    };
    const pertPost = computeRiskExpectedImpact(postR);
    const evPost = postR.probability * pertPost;
    const pubShare = 1 - (r.shareToPrivate || 0);
    const mc = r.mitigationCost || 0;
    const owner = r.mitigationOwner || 'public';
    const mitPub = owner === 'public' ? mc : owner === 'shared' ? mc * 0.5 : 0;
    const mitPriv = owner === 'private' ? mc : owner === 'shared' ? mc * 0.5 : 0;
    return {...r, pertMean: pertPre, expectedValue: evPre, evPostMit: evPost,
      mitigationBenefit: evPre - evPost,
      publicEV: evPre * pubShare, privateEV: evPre * (r.shareToPrivate || 0),
      publicEVPost: evPost * pubShare, privateEVPost: evPost * (r.shareToPrivate || 0),
      mitCostPublic: mitPub, mitCostPrivate: mitPriv, mitCostTotal: mc};
  };
  const cr = constrRisks.map(enrich);
  const or = opsRisks.map(enrich);

  // Pre-mitigation totals (for display / reference)
  const totalConstrEVPre   = sum(cr.map(r => r.expectedValue));
  const annualOpsEVPre     = sum(or.map(r => r.expectedValue));
  // Post-mitigation totals (what actually flows into NPV)
  const totalConstrEV      = sum(cr.map(r => r.evPostMit));
  const publicConstrEV     = sum(cr.map(r => r.publicEVPost));
  const privateConstrEV    = totalConstrEV - publicConstrEV;
  const annualOpsEV        = sum(or.map(r => r.evPostMit));
  const annualPublicOpsEV  = sum(or.map(r => r.publicEVPost));
  const annualPrivateOpsEV = annualOpsEV - annualPublicOpsEV;
  // Mitigation cost totals
  const totalConstrMitCost  = sum(cr.map(r => r.mitCostTotal));
  const publicConstrMitCost = sum(cr.map(r => r.mitCostPublic));
  const annualOpsMitCost    = sum(or.map(r => r.mitCostTotal));
  const publicOpsMitCost    = sum(or.map(r => r.mitCostPublic));
  // Mitigation NPVs (construction one-time at mid-construction; ops annual annuity)
  const totalConstrMitNPV  = totalConstrMitCost  / Math.pow(1 + rate, constYrs / 2);
  const publicConstrMitNPV = publicConstrMitCost / Math.pow(1 + rate, constYrs / 2);
  const totalOpsMitNPV     = npvAnnuity(annualOpsMitCost, opsYrs, rate, constYrs);
  const publicOpsMitNPV    = npvAnnuity(publicOpsMitCost, opsYrs, rate, constYrs);

  // PSC: government delivery — bears ALL residual risk + funds ALL mitigation + PSC premium
  const pscPrem = 1 + (v.pscCostPremium || 0);
  let pscCapexNPV = 0;
  for(let y = 0; y < constYrs; y++){
    pscCapexNPV += (annualCapex[y] * pscPrem) / Math.pow(1 + rate, y + 0.5);
  }
  let pscOpexNPV = 0;
  for(let y = 0; y < opsYrs; y++){
    pscOpexNPV += ((annualOpex[y] || 0) * pscPrem) / Math.pow(1 + rate, constYrs + y + 0.5);
  }
  const pscConstrRiskNPV = totalConstrEV / Math.pow(1 + rate, constYrs / 2);  // post-mit
  const pscOpsRiskNPV = npvAnnuity(annualOpsEV, opsYrs, rate, constYrs);       // post-mit
  let pscRevenueNPV = 0;
  for(let y = 0; y < opsYrs; y++){
    pscRevenueNPV += (annualRevenue[y] || 0) / Math.pow(1 + rate, constYrs + y + 0.5);
  }
  const compNeutralityAdj = (pscCapexNPV + pscOpexNPV) * (v.competitiveNeutralityPct || 0);
  const pscNetCost = pscCapexNPV + pscOpexNPV + pscConstrRiskNPV + pscOpsRiskNPV
                     + totalConstrMitNPV + totalOpsMitNPV
                     + compNeutralityAdj - pscRevenueNPV;

  // P3 from public perspective: public-share residual risk + public-share mitigation cost
  const p3PublicConstrRiskNPV = publicConstrEV / Math.pow(1 + rate, constYrs / 2);
  const p3PublicOpsRiskNPV    = npvAnnuity(annualPublicOpsEV, opsYrs, rate, constYrs);
  let p3NetCost, p3Components;
  if(v.isAvailabilityBased){
    let availabilityNPV = 0;
    for(let y = 0; y < v.availabilityYears; y++){
      const ap = v.availabilityPaymentAnnual * Math.pow(1 + v.availabilityEscalation, y);
      availabilityNPV += ap / Math.pow(1 + rate, (v.availabilityStartYear || 0) + y + 0.5);
    }
    p3NetCost = availabilityNPV + p3PublicConstrRiskNPV + p3PublicOpsRiskNPV
                + publicConstrMitNPV + publicOpsMitNPV;
    p3Components = { availabilityNPV, p3PublicConstrRiskNPV, p3PublicOpsRiskNPV,
                     publicConstrMitNPV, publicOpsMitNPV };
  } else {
    const upfrontFee = v.upfrontConcessionFee || 0;
    const revShare = v.revenueSharePct || 0;
    let foregoneRevNPV = 0;
    for(let y = 0; y < opsYrs; y++){
      foregoneRevNPV += ((annualRevenue[y] || 0) * (1 - revShare)) / Math.pow(1 + rate, constYrs + y + 0.5);
    }
    p3NetCost = foregoneRevNPV + p3PublicConstrRiskNPV + p3PublicOpsRiskNPV
                + publicConstrMitNPV + publicOpsMitNPV - upfrontFee;
    p3Components = { foregoneRevNPV, upfrontFee, revShare,
                     p3PublicConstrRiskNPV, p3PublicOpsRiskNPV,
                     publicConstrMitNPV, publicOpsMitNPV };
  }

  const vfmAbs = pscNetCost - p3NetCost;
  const vfmPct = pscNetCost !== 0 ? vfmAbs / Math.abs(pscNetCost) : 0;

  // Sensitivity grid (uses post-mit EVs as base; scales with riskMult)
  const sensitivityGrid = [];
  for(const dr of [0.030, 0.040, 0.045, 0.050, 0.060, 0.070]){
    const row = { discountRate: dr, cells: [] };
    for(const riskMult of [0.5, 0.75, 1.0, 1.25, 1.5]){
      const psc = (pscCapexNPV + pscOpexNPV) * (rate / dr)
        + totalConstrEV * riskMult / Math.pow(1 + dr, constYrs/2)
        + npvAnnuity(annualOpsEV * riskMult, opsYrs, dr, constYrs)
        + totalConstrMitCost / Math.pow(1 + dr, constYrs/2)
        + npvAnnuity(annualOpsMitCost, opsYrs, dr, constYrs)
        + compNeutralityAdj - pscRevenueNPV * (rate / dr);
      const p3Public = publicConstrEV * riskMult / Math.pow(1 + dr, constYrs/2)
        + npvAnnuity(annualPublicOpsEV * riskMult, opsYrs, dr, constYrs)
        + publicConstrMitCost / Math.pow(1 + dr, constYrs/2)
        + npvAnnuity(publicOpsMitCost, opsYrs, dr, constYrs);
      let p3 = p3Public;
      if(v.isAvailabilityBased){
        let apNPV = 0;
        for(let y = 0; y < v.availabilityYears; y++){
          apNPV += (v.availabilityPaymentAnnual * Math.pow(1 + v.availabilityEscalation, y)) / Math.pow(1 + dr, (v.availabilityStartYear||0) + y + 0.5);
        }
        p3 += apNPV;
      } else {
        let fr = 0;
        for(let y = 0; y < opsYrs; y++){
          fr += ((annualRevenue[y] || 0) * (1 - (v.revenueSharePct || 0))) / Math.pow(1 + dr, constYrs + y + 0.5);
        }
        p3 += fr - (v.upfrontConcessionFee || 0);
      }
      row.cells.push({ riskMult, psc, p3, vfm: psc - p3 });
    }
    sensitivityGrid.push(row);
  }

  return {
    pscDiscountRate: rate,
    pscCapexNPV, pscOpexNPV, pscConstrRiskNPV, pscOpsRiskNPV,
    pscRevenueNPV, compNeutralityAdj, pscNetCost,
    pscMitConstrNPV: totalConstrMitNPV, pscMitOpsNPV: totalOpsMitNPV,
    p3NetCost, p3Components, isAvailabilityBased: v.isAvailabilityBased,
    vfm: vfmAbs, vfmPct,
    mitigation: {
      construction: { totalAnnualOrOneTime: totalConstrMitCost, public: publicConstrMitCost,
                       private: totalConstrMitCost - publicConstrMitCost,
                       totalNPV: totalConstrMitNPV, publicNPV: publicConstrMitNPV },
      operations:   { totalAnnualOrOneTime: annualOpsMitCost, public: publicOpsMitCost,
                       private: annualOpsMitCost - publicOpsMitCost,
                       totalNPV: totalOpsMitNPV, publicNPV: publicOpsMitNPV },
      totalNPV: totalConstrMitNPV + totalOpsMitNPV,
      publicNPV: publicConstrMitNPV + publicOpsMitNPV,
      benefitConstr: totalConstrEVPre - totalConstrEV,
      benefitOpsAnnual: annualOpsEVPre - annualOpsEV,
    },
    risks: {
      construction: { total: totalConstrEV, totalPre: totalConstrEVPre, public: publicConstrEV, private: privateConstrEV, items: cr },
      operations:   { annual: annualOpsEV, annualPre: annualOpsEVPre, annualPublic: annualPublicOpsEV, annualPrivate: annualPrivateOpsEV,
                      npvTotal: pscOpsRiskNPV, items: or },
    },
    sensitivityGrid,
  };
}

// ============================================================
//                          UI
// ============================================================

const TH = ({children, className=''}) => <th className={`px-3 py-2 text-left text-[11px] uppercase tracking-wider font-medium text-stone-400 border-b border-stone-700 ${className}`}>{children}</th>;
const TD = ({children, className='', mono=true}) => <td className={`px-3 py-1.5 text-sm border-b border-stone-800/60 ${mono?'font-mono tabular-nums':''} ${className}`}>{children}</td>;

function Field({label, hint, children}){
  return <label className="flex flex-col gap-1">
    <span className="text-[11px] uppercase tracking-wider text-stone-400 font-medium">{label}</span>
    {children}
    {hint && <span className="text-[10px] text-stone-500">{hint}</span>}
  </label>;
}
function NumInput({value, onChange, step=1, prefix, suffix}){
  const [local,setLocal] = useState(value);
  useEffect(()=>setLocal(value),[value]);
  return <div className="flex items-center bg-stone-900 border border-stone-700 rounded focus-within:border-amber-500 transition">
    {prefix && <span className="px-2 text-stone-500 text-sm font-mono">{prefix}</span>}
    <input type="number" step={step} value={local}
      onChange={e=>setLocal(e.target.value)} onBlur={()=>onChange(parseFloat(local)||0)}
      className="flex-1 bg-transparent px-2 py-1.5 text-sm text-stone-100 font-mono tabular-nums focus:outline-none w-full min-w-0"/>
    {suffix && <span className="px-2 text-stone-500 text-sm font-mono">{suffix}</span>}
  </div>;
}
function TextInput({value, onChange}){
  return <input type="text" value={value} onChange={e=>onChange(e.target.value)}
    className="bg-stone-900 border border-stone-700 rounded px-2 py-1.5 text-sm text-stone-100 focus:outline-none focus:border-amber-500"/>;
}
function Select({value, onChange, options}){
  return <select value={value} onChange={e=>onChange(e.target.value)}
    className="bg-stone-900 border border-stone-700 rounded px-2 py-1.5 text-sm text-stone-100 focus:outline-none focus:border-amber-500">
    {options.map(o=><option key={o} value={o}>{o}</option>)}
  </select>;
}
function Toggle({value, onChange, label}){
  return <button onClick={()=>onChange(!value)}
    className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs uppercase tracking-wider border transition ${value?'bg-amber-500/10 border-amber-500/50 text-amber-300':'bg-stone-900 border-stone-700 text-stone-400'}`}>
    <span className={`w-2 h-2 rounded-full ${value?'bg-amber-400':'bg-stone-600'}`}/>{label}
  </button>;
}
function Section({title, subtitle, children, action}){
  return <section className="mb-8">
    <div className="flex items-end justify-between mb-3 pb-2 border-b border-stone-700/60">
      <div><h3 className="text-base font-serif text-stone-100">{title}</h3>
        {subtitle && <p className="text-xs text-stone-500 mt-0.5">{subtitle}</p>}</div>
      {action}
    </div>{children}
  </section>;
}
function Metric({label, value, sub, accent='amber'}){
  const a = {amber:'text-amber-300',green:'text-emerald-300',red:'text-rose-300',stone:'text-stone-200',violet:'text-violet-300'};
  return <div className="bg-stone-900/50 border border-stone-700/60 rounded p-4">
    <div className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">{label}</div>
    <div className={`text-2xl font-mono tabular-nums mt-1 ${a[accent]}`}>{value}</div>
    {sub && <div className="text-xs text-stone-500 mt-1">{sub}</div>}
  </div>;
}
function DirectForecastTable({rows, onChange, keyName, unitLabel, total}){
  const addRow = ()=>onChange([...rows, {[keyName]:rows.length+1, total:0}]);
  const updateRow = (i, patch)=>onChange(rows.map((r,idx)=>idx===i?{...r,...patch}:r));
  const removeRow = (i)=>onChange(rows.filter((_,idx)=>idx!==i));
  return <div>
    <table className="w-full mb-2"><thead><tr><TH>{unitLabel}</TH><TH className="text-right">Amount</TH><TH></TH></tr></thead>
    <tbody>{rows.map((r,i)=>(
      <tr key={i}><TD><NumInput value={r[keyName]} onChange={v=>updateRow(i,{[keyName]:v})}/></TD>
        <TD className="text-right"><NumInput value={r.total} onChange={v=>updateRow(i,{total:v})} prefix="$"/></TD>
        <TD><button onClick={()=>removeRow(i)} className="text-xs text-rose-400 hover:text-rose-300">remove</button></TD></tr>))}</tbody></table>
    <div className="flex items-center justify-between">
      <button onClick={addRow} className="text-xs text-amber-300 hover:text-amber-200">+ add row</button>
      <span className="text-xs text-stone-400">Total: <span className="font-mono text-amber-300">{fmt$(total)}</span></span>
    </div>
  </div>;
}
function CapexItemTable({items, updateItem}){
  return <div className="overflow-x-auto"><table className="w-full">
    <thead><tr><TH>Line Item</TH><TH className="text-right">Base Cost (USD)</TH><TH className="text-center">Inflate?</TH><TH className="text-right">Inflation Rate</TH><TH>Distribution Curve</TH></tr></thead>
    <tbody>{items.map(it=>(
      <tr key={it.id} className="hover:bg-stone-900/40">
        <TD mono={false} className="text-stone-200">{it.label}</TD>
        <TD className="text-right"><NumInput value={it.base} onChange={v=>updateItem(it.id,{base:v})} prefix="$"/></TD>
        <TD className="text-center"><Toggle value={it.inflate} onChange={v=>updateItem(it.id,{inflate:v})} label={it.inflate?'ON':'OFF'}/></TD>
        <TD className="text-right"><NumInput value={it.inflRate} onChange={v=>updateItem(it.id,{inflRate:v})} step={0.005} suffix="%"/></TD>
        <TD><Select value={it.curve} onChange={v=>updateItem(it.id,{curve:v})} options={CURVE_TYPES}/></TD>
      </tr>))}</tbody></table></div>;
}

function GeneralTab({model, setModel}){
  const g = model.general, w = model.waterfall;
  const setG = (k,v)=>setModel({...model, general:{...g,[k]:v}});
  const setW = (k,v)=>setModel({...model, waterfall:{...w,[k]:v}});
  return <div className="max-w-4xl">
    <Section title="Project Definition" subtitle="Core dates and tenor.">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Project Name"><TextInput value={g.projectName} onChange={v=>setG('projectName',v)}/></Field>
        <Field label="Sponsor / Concessionaire"><TextInput value={g.sponsor} onChange={v=>setG('sponsor',v)}/></Field>
        <Field label="State"><TextInput value={g.state} onChange={v=>setG('state',v)}/></Field>
        <Field label="Financial Close Date"><TextInput value={g.financialCloseDate} onChange={v=>setG('financialCloseDate',v)}/></Field>
        <Field label="Construction (months)"><NumInput value={g.constructionMonths} onChange={v=>setG('constructionMonths',v)} suffix="mo"/></Field>
        <Field label="Operations (years)"><NumInput value={g.operationsYears} onChange={v=>setG('operationsYears',v)} suffix="yr"/></Field>
        <Field label="Discount Rate (NPV/LLCR/PLCR)"><NumInput value={g.discountRate} onChange={v=>setG('discountRate',v)} step={0.005} suffix="%"/></Field>
      </div>
    </Section>
    <Section title="Period Framework" subtitle="Semi-annual / annual; CY or FY. Partial periods auto-handled by day-count.">
      <div className="grid grid-cols-3 gap-4">
        <Field label="Periods per year"><Select value={String(g.periodsPerYear)} onChange={v=>setG('periodsPerYear',parseInt(v))} options={['1','2']}/></Field>
        <Field label="Use Fiscal Year?"><Toggle value={g.useFiscalYear} onChange={v=>setG('useFiscalYear',v)} label={g.useFiscalYear?'FY':'CY'}/></Field>
        <Field label="FY Start Month" hint="1=Jan; 7=July"><NumInput value={g.fyStartMonth} onChange={v=>setG('fyStartMonth',v)}/></Field>
      </div>
    </Section>
    <Section title="Waterfall Mode" subtitle="Both modes compute & enforce the 1.0x overall obligation ratio.">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Mode"><Select value={w.mode} onChange={v=>setW('mode',v)} options={WATERFALL_MODES}/></Field>
        <Field label="Overall obligation min Rev/(Opex+DS)"><NumInput value={w.overallObligationMin} onChange={v=>setW('overallObligationMin',v)} step={0.05}/></Field>
      </div>
      <p className="text-xs text-stone-500 mt-3">Opex-first: CFADS (Rev−Opex) → Debt Service → Equity. Debt-first: Revenue → Debt Service → Opex → Equity. In both modes the 1x test Rev/(Opex+DS) ≥ floor is reported per period.</p>
    </Section>
  </div>;
}

function CapexTab({model, setModel}){
  const c = model.capex;
  const setC = patch => setModel({...model, capex:{...c, ...patch}});
  const updateItem = (id, patch) => setC({items: c.items.map(it=>it.id===id?{...it,...patch}:it)});
  return <div>
    <Section title="Direct-Forecast Ingestion" subtitle="Override line-item build-up with pre-forecasted monthly totals.">
      <div className="flex items-center gap-3 mb-3"><Toggle value={c.useDirectForecast} onChange={v=>setC({useDirectForecast:v})} label="Use direct forecast"/></div>
      {c.useDirectForecast && <DirectForecastTable rows={c.directForecast} onChange={rows=>setC({directForecast:rows})} keyName="month" unitLabel="Month" total={sum(c.directForecast.map(r=>r.total||0))}/>}
    </Section>
    <Section title="Design-Build Contract" subtitle="D&B packages with per-line inflation & curve."><CapexItemTable items={c.items.filter(i=>i.group==='D&B')} updateItem={updateItem}/></Section>
    <Section title="ROW, Utilities, Environmental, Advisory, Reserves" subtitle="Non-D&B capex."><CapexItemTable items={c.items.filter(i=>i.group==='Other')} updateItem={updateItem}/></Section>
  </div>;
}

function PaygoTab({model, setModel}){
  const p = model.paygo;
  const setP = patch => setModel({...model, paygo:{...p, ...patch}});
  return <div className="max-w-3xl">
    <Section title="Paygo — Net Existing Toll Revenues" subtitle="Concessionaire's existing portfolio revenues used as paygo during construction.">
      <div className="flex items-center gap-3 mb-4"><Toggle value={p.enabled} onChange={v=>setP({enabled:v})} label={p.enabled?'Enabled':'Disabled'}/></div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Total Paygo Contribution"><NumInput value={p.totalContribution} onChange={v=>setP({totalContribution:v})} prefix="$" step={1000000}/></Field>
        <Field label="Distribution Curve"><Select value={p.distributionCurve} onChange={v=>setP({distributionCurve:v})} options={CURVE_TYPES.filter(c=>c!=='Custom')}/></Field>
        <Field label="Description / Notes"><TextInput value={p.description} onChange={v=>setP({description:v})}/></Field>
      </div>
      <p className="text-xs text-stone-500 mt-4">Paygo behaves as zero-cost funding during construction and is included in Sources & Uses. It receives no debt service.</p>
    </Section>
  </div>;
}

function RevenueTab({model, setModel}){
  const r = model.revenue;
  const setR = patch => setModel({...model, revenue:{...r, ...patch}});
  const updateClass = (id, patch) => setR({vehicleClasses: r.vehicleClasses.map(c=>c.id===id?{...c,...patch}:c)});
  const totalShare = sum(r.vehicleClasses.map(c=>c.share));
  return <div>
    <Section title="Direct-Forecast Ingestion" subtitle="Annual revenue forecast overrides build-up. Allocated to periods by day-count.">
      <div className="flex items-center gap-3 mb-3"><Toggle value={r.useDirectForecast} onChange={v=>setR({useDirectForecast:v})} label="Use direct forecast"/></div>
      {r.useDirectForecast && <DirectForecastTable rows={r.directForecast} onChange={rows=>setR({directForecast:rows})} keyName="year" unitLabel="Op. Year" total={sum(r.directForecast.map(x=>x.total||0))}/>}
    </Section>
    <Section title="Traffic & Toll Build-up">
      <div className="grid grid-cols-3 gap-4 mb-4">
        <Field label="Year-1 AADT"><NumInput value={r.aadtY1} onChange={v=>setR({aadtY1:v})}/></Field>
        <Field label="Days Open per Year"><NumInput value={r.daysOpen} onChange={v=>setR({daysOpen:v})}/></Field>
        <Field label="Apply Toll Escalation?"><Toggle value={r.inflate} onChange={v=>setR({inflate:v})} label={r.inflate?'ON':'OFF'}/></Field>
        <Field label="Toll Escalation Rate"><NumInput value={r.tollEscalation} onChange={v=>setR({tollEscalation:v})} step={0.005} suffix="%"/></Field>
        <Field label="Ramp-up factors (Y1..Yn)" hint="Comma-separated"><TextInput value={r.aadtRamp.join(', ')} onChange={v=>setR({aadtRamp:v.split(',').map(x=>parseFloat(x.trim())||0)})}/></Field>
      </div>
    </Section>
    <Section title="Vehicle Classes" subtitle={`Total share: ${(totalShare*100).toFixed(1)}%`}>
      <table className="w-full">
        <thead><tr><TH>Class</TH><TH className="text-right">Toll ($/trip)</TH><TH className="text-right">Share</TH><TH className="text-right">Growth</TH></tr></thead>
        <tbody>{r.vehicleClasses.map(c=>(
          <tr key={c.id} className="hover:bg-stone-900/40">
            <TD mono={false} className="text-stone-200">{c.name}</TD>
            <TD className="text-right"><NumInput value={c.toll} onChange={v=>updateClass(c.id,{toll:v})} prefix="$" step={0.25}/></TD>
            <TD className="text-right"><NumInput value={c.share} onChange={v=>updateClass(c.id,{share:v})} step={0.01} suffix="%"/></TD>
            <TD className="text-right"><NumInput value={c.growthRate} onChange={v=>updateClass(c.id,{growthRate:v})} step={0.005} suffix="%"/></TD>
          </tr>))}</tbody>
      </table>
    </Section>
  </div>;
}

function OpexTab({model, setModel}){
  const o = model.opex;
  const setO = patch => setModel({...model, opex:{...o, ...patch}});
  const updateItem = (id, patch) => setO({items: o.items.map(i=>i.id===id?{...i,...patch}:i)});
  return <div>
    <Section title="Direct-Forecast Ingestion">
      <div className="flex items-center gap-3 mb-3"><Toggle value={o.useDirectForecast} onChange={v=>setO({useDirectForecast:v})} label="Use direct forecast"/></div>
      {o.useDirectForecast && <DirectForecastTable rows={o.directForecast} onChange={rows=>setO({directForecast:rows})} keyName="year" unitLabel="Op. Year" total={sum(o.directForecast.map(x=>x.total||0))}/>}
    </Section>
    <Section title="Operating Cost Line Items" subtitle="Annual base in Y1 dollars. Per-txn items scale with traffic.">
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Field label="Apply Opex Inflation?"><Toggle value={o.inflate} onChange={v=>setO({inflate:v})} label={o.inflate?'ON':'OFF'}/></Field>
        <Field label="Opex Inflation Rate"><NumInput value={o.inflRate} onChange={v=>setO({inflRate:v})} step={0.005} suffix="%"/></Field>
      </div>
      <table className="w-full">
        <thead><tr><TH>Line Item</TH><TH className="text-right">Base ($/yr or $/txn)</TH><TH className="text-right">Per-Txn?</TH><TH className="text-right">Txn Share</TH></tr></thead>
        <tbody>{o.items.map(it=>(
          <tr key={it.id} className="hover:bg-stone-900/40">
            <TD mono={false} className="text-stone-200">{it.label}</TD>
            <TD className="text-right"><NumInput value={it.base} onChange={v=>updateItem(it.id,{base:v})} prefix="$" step={it.perTxn?0.01:100000}/></TD>
            <TD className="text-right"><Toggle value={!!it.perTxn} onChange={v=>updateItem(it.id,{perTxn:v})} label={it.perTxn?'YES':'NO'}/></TD>
            <TD className="text-right">{it.perTxn ? <NumInput value={it.share||0} onChange={v=>updateItem(it.id,{share:v})} step={0.05} suffix="%"/> : <span className="text-stone-600">—</span>}</TD>
          </tr>))}</tbody>
      </table>
    </Section>
  </div>;
}

function FinancingTab({model, setModel}){
  const f = model.financing;
  const setF = patch => setModel({...model, financing:{...f, ...patch}});
  const updateInst = (id, patch) => setF({instruments: f.instruments.map(i=>i.id===id?{...i,...patch}:i)});
  const addInst = ()=>{
    const id = 'i'+Math.random().toString(36).slice(2,8);
    setF({instruments:[...f.instruments,{id,type:'Bank Loan',amount:50_000_000,rate:0.05,tenorYears:20,closeDate:model.general.financialCloseDate,seniority:'Senior',repaymentStyle:'Level debt service',drawdownPriority:5,targetDSCR:1.30,ioYears:0,deferralYears:0,dayCount:'30/360',covenants:''}]});
  };
  return <div>
    <Section title="Construction-Period Financing Parameters">
      <div className="grid grid-cols-3 gap-4">
        <Field label="Blended IDC Rate — non-TIFIA debt"><NumInput value={f.blendedIDCRateForNonTIFIA} onChange={v=>setF({blendedIDCRateForNonTIFIA:v})} step={0.005} suffix="%"/></Field>
        <Field label="Financing Fees (% of total debt)"><NumInput value={f.financingFeesPctOfDebt} onChange={v=>setF({financingFeesPctOfDebt:v})} step={0.005} suffix="%"/></Field>
        <Field label="Issuance Cost Base Year" hint="Per-instrument issuance costs escalated from this year to FC year"><NumInput value={f.issuanceCostBaseYear} onChange={v=>setF({issuanceCostBaseYear:v})}/></Field>
      </div>
      <p className="text-xs text-stone-500 mt-3">TIFIA construction interest is computed separately (act/act day-count, semi-annual cap). See TIFIA tab. Issuance costs are set per instrument below and added to Uses.</p>
    </Section>
    <Section title="Capital Stack" subtitle="Per-instrument seniority, repayment, day-count, deferral, covenants."
      action={<button onClick={addInst} className="text-xs px-3 py-1.5 bg-amber-500/10 border border-amber-500/50 text-amber-300 rounded hover:bg-amber-500/20">+ Add Instrument</button>}>
      <div className="space-y-3">{f.instruments.map(inst=>(
        <div key={inst.id} className="bg-stone-900/50 border border-stone-700/60 rounded p-4">
          <div className="grid grid-cols-4 gap-3 mb-3">
            <Field label="Type"><Select value={inst.type} onChange={v=>updateInst(inst.id,{type:v})} options={INSTRUMENT_TYPES}/></Field>
            <Field label="Seniority"><Select value={inst.seniority} onChange={v=>updateInst(inst.id,{seniority:v})} options={SENIORITY}/></Field>
            <Field label="Principal"><NumInput value={inst.amount} onChange={v=>updateInst(inst.id,{amount:v})} prefix="$" step={1000000}/></Field>
            <Field label="Rate"><NumInput value={inst.rate} onChange={v=>updateInst(inst.id,{rate:v})} step={0.0025} suffix="%"/></Field>
            <Field label="Tenor (yrs)"><NumInput value={inst.tenorYears} onChange={v=>updateInst(inst.id,{tenorYears:v})}/></Field>
            <Field label="Close Date"><TextInput value={inst.closeDate} onChange={v=>updateInst(inst.id,{closeDate:v})}/></Field>
            <Field label="Repayment Style"><Select value={inst.repaymentStyle} onChange={v=>updateInst(inst.id,{repaymentStyle:v})} options={REPAYMENT_STYLES}/></Field>
            <Field label="Day Count"><Select value={inst.dayCount} onChange={v=>updateInst(inst.id,{dayCount:v})} options={DAY_COUNT}/></Field>
            <Field label="Draw Priority"><NumInput value={inst.drawdownPriority} onChange={v=>updateInst(inst.id,{drawdownPriority:v})}/></Field>
            <Field label="Target DSCR"><NumInput value={inst.targetDSCR} onChange={v=>updateInst(inst.id,{targetDSCR:v})} step={0.05}/></Field>
            <Field label="IO Years"><NumInput value={inst.ioYears} onChange={v=>updateInst(inst.id,{ioYears:v})}/></Field>
            <Field label="Deferral Years"><NumInput value={inst.deferralYears} onChange={v=>updateInst(inst.id,{deferralYears:v})}/></Field>
          </div>
          <div className="grid grid-cols-2 gap-4 mt-3">
            <Field label="Issuance Cost ($, base year)" hint={`Base yr: ${f.issuanceCostBaseYear||2024}. Escalated to FC.`}><NumInput value={inst.issuanceCost} onChange={v=>updateInst(inst.id,{issuanceCost:v})} prefix="$"/></Field>
            <Field label="Issuance Cost Escalation (%/yr)"><NumInput value={inst.issuanceCostEscalation} onChange={v=>updateInst(inst.id,{issuanceCostEscalation:v})} step={0.005} suffix="%"/></Field>
          </div>
          <Field label="Covenants / Notes"><TextInput value={inst.covenants} onChange={v=>updateInst(inst.id,{covenants:v})}/></Field>
          {inst.repaymentStyle === 'Phased (multi-regime)' && (()=>{
            const phases = inst.phases || [];
            const tenorPeriods = Math.round((inst.tenorYears||0) * (model.general.periodsPerYear||2));
            const ppy = model.general.periodsPerYear || 2;
            const updatePhase = (idx, patch) => {
              const np = phases.map((p,i)=> i===idx ? {...p, ...patch} : p);
              updateInst(inst.id, {phases: np});
            };
            const addPhase = () => {
              const last = phases[phases.length-1];
              const start = last ? last.endPeriod : 0;
              const end = Math.min(tenorPeriods, start + ppy * 5);
              updateInst(inst.id, {phases: [...phases, {regime:'sculpt', endPeriod:end, targetDSCR:1.20}]});
            };
            const removePhase = (idx) => updateInst(inst.id, {phases: phases.filter((_,i)=>i!==idx)});
            return <div className="mt-3 p-3 bg-stone-900/40 border border-amber-500/30 rounded">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-amber-300">Phased Repayment Schedule</div>
                  <div className="text-[10px] text-stone-500">Tenor: {tenorPeriods} periods ({inst.tenorYears}y × {ppy}/year)</div>
                </div>
                <button onClick={addPhase} className="text-xs px-3 py-1 bg-amber-500/10 border border-amber-500/50 text-amber-300 rounded hover:bg-amber-500/20">+ Add Phase</button>
              </div>
              <table className="w-full text-xs">
                <thead><tr>
                  <TH>#</TH>
                  <TH>Regime</TH>
                  <TH className="text-right">From Period</TH>
                  <TH className="text-right">End Period</TH>
                  <TH className="text-right">Years</TH>
                  <TH className="text-right">Target DSCR</TH>
                  <TH></TH>
                </tr></thead>
                <tbody>{phases.map((p, idx) => {
                  const startP = idx === 0 ? 0 : (phases[idx-1].endPeriod || 0);
                  const durPeriods = (p.endPeriod || 0) - startP;
                  const durYears = (durPeriods / ppy).toFixed(1);
                  const isSculpt = p.regime === 'sculpt';
                  return <tr key={idx} className="hover:bg-stone-900/40">
                    <TD className="text-stone-400">{idx+1}</TD>
                    <TD><Select value={p.regime} onChange={v=>updatePhase(idx,{regime:v})} options={PHASE_REGIMES}/></TD>
                    <TD className="text-right text-stone-400">{startP}</TD>
                    <TD className="text-right"><NumInput value={p.endPeriod} onChange={v=>updatePhase(idx,{endPeriod:v})}/></TD>
                    <TD className="text-right text-stone-400">{durYears}y</TD>
                    <TD className="text-right">{isSculpt ? <NumInput value={p.targetDSCR||1.20} onChange={v=>updatePhase(idx,{targetDSCR:v})} step={0.05}/> : <span className="text-stone-600">—</span>}</TD>
                    <TD><button onClick={()=>removePhase(idx)} className="text-xs text-rose-400 hover:text-rose-300">×</button></TD>
                  </tr>;
                })}</tbody>
              </table>
              <div className="flex mt-3 h-6 rounded overflow-hidden border border-stone-700/60">
                {phases.map((p, idx) => {
                  const startP = idx === 0 ? 0 : (phases[idx-1].endPeriod || 0);
                  const widthPct = ((p.endPeriod - startP) / Math.max(1, tenorPeriods)) * 100;
                  const colors = {defer:'#475569', io:'#fbbf24', sculpt:'#a78bfa', level:'#10b981', 'equal-principal':'#fb7185'};
                  return <div key={idx} style={{width:`${widthPct}%`, background:colors[p.regime]||'#666'}} className="flex items-center justify-center text-[9px] font-medium text-stone-950" title={`${p.regime} (${startP}→${p.endPeriod})`}>
                    {widthPct > 8 ? p.regime : ''}
                  </div>;
                })}
              </div>
              <div className="text-[10px] text-stone-500 mt-2">Phases run sequentially. Each phase's <span className="text-amber-300">end period is exclusive</span> (i.e., it's the first period of the next phase). Last phase should end at the loan's tenor period count. If residual balance remains, it bullets at maturity.</div>
            </div>;
          })()}
          <div className="mt-2 flex justify-end"><button onClick={()=>setF({instruments:f.instruments.filter(i=>i.id!==inst.id)})} className="text-xs text-rose-400 hover:text-rose-300">Remove instrument</button></div>
        </div>))}</div>
    </Section>
  </div>;
}

function TIFIATab({model, setModel, results}){
  const t = model.tifia;
  const setT = patch => setModel({...model, tifia:{...t, ...patch}});
  const tifiaInst = model.financing.instruments.find(i=>i.id===t.instrumentId);
  const test50 = results.tifia50Test;
  return <div>
    <Section title="TIFIA Loan Identification">
      <div className="grid grid-cols-2 gap-4">
        <Field label="TIFIA Instrument"><Select value={t.instrumentId} onChange={v=>setT({instrumentId:v})} options={model.financing.instruments.map(i=>i.id)}/></Field>
        <div className="text-xs text-stone-400 pt-6">{tifiaInst?`${tifiaInst.type} · ${fmt$(tifiaInst.amount)} · ${tifiaInst.tenorYears}y tenor`:'None selected'}</div>
      </div>
    </Section>
    <Section title="Treasury + Credit Spread" subtitle="All-in rate = Treasury + tenor-based spread (bps).">
      <div className="grid grid-cols-3 gap-4 mb-4">
        <Field label="Treasury Rate"><NumInput value={t.treasuryRate} onChange={v=>setT({treasuryRate:v})} step={0.0005} suffix="%"/></Field>
        <Field label="Use Tenor Spread Curve?"><Toggle value={t.useTenorSpreadCurve} onChange={v=>setT({useTenorSpreadCurve:v})} label={t.useTenorSpreadCurve?'ON':'OFF'}/></Field>
        <Field label="Manual Spread (bps, if curve off)"><NumInput value={t.spreadBps} onChange={v=>setT({spreadBps:v})}/></Field>
      </div>
      <div className="bg-stone-900/40 border border-stone-700/60 rounded p-3 mb-3">
        <div className="text-[11px] uppercase tracking-wider text-stone-400 mb-2">Tenor Spread Curve</div>
        <table className="w-full text-sm"><thead><tr><TH>Max Tenor (yrs)</TH><TH className="text-right">Spread (bps)</TH><TH></TH></tr></thead>
          <tbody>{t.tenorSpreadCurve.map((row,i)=>(<tr key={i}>
            <TD><NumInput value={row.maxTenor} onChange={v=>setT({tenorSpreadCurve:t.tenorSpreadCurve.map((r,idx)=>idx===i?{...r,maxTenor:v}:r)})} suffix="yr"/></TD>
            <TD className="text-right"><NumInput value={row.bps} onChange={v=>setT({tenorSpreadCurve:t.tenorSpreadCurve.map((r,idx)=>idx===i?{...r,bps:v}:r)})} suffix="bps"/></TD>
            <TD><button className="text-xs text-rose-400" onClick={()=>setT({tenorSpreadCurve:t.tenorSpreadCurve.filter((_,idx)=>idx!==i)})}>×</button></TD>
          </tr>))}</tbody></table>
        <button onClick={()=>setT({tenorSpreadCurve:[...t.tenorSpreadCurve,{maxTenor:40,bps:5}]})} className="text-xs text-amber-300 mt-2">+ add tier</button>
      </div>
      <div className="bg-stone-900/40 border border-stone-700/60 rounded p-3 mb-3">
        <div className="text-[11px] uppercase tracking-wider text-stone-400 mb-2">TIFIA Admin + Monitoring Fees (throughout loan tenor)</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Admin Fee (annual, $)" hint="US DOT TIFIA standard ~$13,500/yr"><NumInput value={t.adminFeeAnnual} onChange={v=>setT({adminFeeAnnual:v})} prefix="$"/></Field>
          <Field label="Monitoring Fee (bps/yr on outstanding)" hint="Charged on outstanding TIFIA balance"><NumInput value={t.monitoringFeeBps} onChange={v=>setT({monitoringFeeBps:v})} step={0.5} suffix="bps"/></Field>
        </div>
        <div className="text-[11px] text-stone-500 mt-2">Total over life: <span className="text-amber-300">{fmt$(results.totalTifiaFees)}</span> · deducted from CFADS before DSCR calc.</div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Metric label="All-in TIFIA rate" value={fmtPct(results.tifiaAllInRate,3)} sub={tifiaInst?`Treasury ${fmtPct(t.treasuryRate,3)} + ${tifiaSpreadBps(tifiaInst.tenorYears,t)}bps`:''} accent="amber"/>
        <Metric label="TIFIA principal at FC" value={tifiaInst?fmt$(tifiaInst.amount):'—'} accent="stone"/>
        <Metric label="Principal incl. cap. interest" value={tifiaInst?fmt$(tifiaInst.principalAfterIDC||(tifiaInst.amount+results.capitalizedTIFIAInterest)):'—'} sub={`Cap. interest: ${fmt$(results.capitalizedTIFIAInterest)}`} accent="violet"/>
      </div>
    </Section>
    <Section title="Construction Interest (act/act, semi-annual cap)" subtitle="Daily accrual on outstanding TIFIA balance; capitalized every 6 months — separate from monthly draws.">
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Metric label="Construction months" value={`${model.general.constructionMonths}`} accent="stone"/>
        <Metric label="Cap. periods" value={`${results.tifiaConstr.capitalizations.length}`} accent="stone"/>
        <Metric label="Total cap. interest" value={fmt$(results.capitalizedTIFIAInterest)} accent="amber"/>
      </div>
      <div className="overflow-x-auto max-h-64 border border-stone-700/60 rounded">
        <table className="w-full text-xs"><thead className="bg-stone-900 sticky top-0">
          <tr><TH>Month</TH><TH className="text-right">Interest Accrued</TH><TH className="text-right">Capitalized?</TH><TH className="text-right">Balance</TH></tr></thead>
          <tbody>{results.tifiaConstr.monthlyInterest.map((intM,i)=>{
            const cap = results.tifiaConstr.capitalizations.find(c=>c.monthIdx===i);
            return <tr key={i}><TD>M{i+1}</TD><TD className="text-right text-amber-300">{fmt$(intM)}</TD><TD className="text-right text-violet-300">{cap?fmt$(cap.amount):'—'}</TD><TD className="text-right text-stone-200">{fmt$(results.tifiaConstr.monthlyBalance[i])}</TD></tr>;
          })}</tbody></table>
      </div>
    </Section>
    <Section title="50% Outstanding Test" subtitle="Per TIFIA: at test date, outstanding principal must be ≤ 50% of original.">
      <div className="grid grid-cols-3 gap-4 mb-3">
        <Field label="Enforce?"><Toggle value={t.enforce50PctTest} onChange={v=>setT({enforce50PctTest:v})} label={t.enforce50PctTest?'ON':'OFF'}/></Field>
        <Field label="Years before maturity"><NumInput value={t.fiftyPercentTestYearsBeforeMaturity} onChange={v=>setT({fiftyPercentTestYearsBeforeMaturity:v})} suffix="yr"/></Field>
      </div>
      {test50 && (
        <div className={`p-3 rounded border ${test50.infeasible?'border-rose-700/50 bg-rose-900/10':test50.applied?'border-amber-700/50 bg-amber-900/10':'border-emerald-700/50 bg-emerald-900/10'}`}>
          <div className="text-[11px] uppercase tracking-wider text-stone-400 mb-1">Test result</div>
          <div className="text-sm font-mono">{test50.infeasible
            ? `INFEASIBLE — even at minimum DSCR ${fmtRatio(test50.effectiveDSCR)} the balance at test date stays above the 50% cap. Reduce TIFIA principal or extend tenor.`
            : test50.applied
              ? `Joint solver active. Natural sculpt at target ${fmtRatio(results.tifiaTargetDSCR)} would leave ${fmt$(test50.naturalBalance ?? test50.beforeBal)} at test (cap ${fmt$(test50.maxAllowed)}). Effective DSCR re-solved to ${fmtRatio(test50.effectiveDSCR ?? results.tifiaEffectiveDSCR)} — schedule respects both target and 50% test.`
              : `Passes natively. Balance at test date ${fmt$(test50.beforeBal)} ≤ 50% cap ${fmt$(test50.maxAllowed)}. Target DSCR ${fmtRatio(results.tifiaTargetDSCR)} preserved.`}</div>
        </div>
      )}
      {results.tifiaEffectiveDSCR != null && results.tifiaEffectiveDSCR !== results.tifiaTargetDSCR && (
        <div className="grid grid-cols-2 gap-3 mt-3">
          <Metric label="Target DSCR (input)" value={fmtRatio(results.tifiaTargetDSCR)} accent="stone"/>
          <Metric label="Effective DSCR (achieved)" value={fmtRatio(results.tifiaEffectiveDSCR)} accent={results.tifiaEffectiveDSCR < results.tifiaTargetDSCR?'red':'green'} sub={results.tifiaEffectiveDSCR < results.tifiaTargetDSCR?'Tightened by 50% test':'No constraint binding'}/>
        </div>
      )}
    </Section>
    <Section title="Coverage & Sizing Constraints" subtitle="DSCR/LLCR/PLCR/WAL limits used by the optimizer.">
      <div className="grid grid-cols-4 gap-3">
        <Field label="Min DSCR"><NumInput value={t.minDSCR} onChange={v=>setT({minDSCR:v})} step={0.05}/></Field>
        <Field label="Min LLCR"><NumInput value={t.minLLCR} onChange={v=>setT({minLLCR:v})} step={0.05}/></Field>
        <Field label="Min PLCR"><NumInput value={t.minPLCR} onChange={v=>setT({minPLCR:v})} step={0.05}/></Field>
        <Field label="Max WAL (yrs)"><NumInput value={t.maxWAL} onChange={v=>setT({maxWAL:v})}/></Field>
      </div>
    </Section>
    <Section title="Equity Distribution Lockup Conditions">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Lockup if Senior DSCR <"><NumInput value={t.lockupDSCR} onChange={v=>setT({lockupDSCR:v})} step={0.05}/></Field>
        <Field label="Lockup if LLCR <"><NumInput value={t.lockupLLCR} onChange={v=>setT({lockupLLCR:v})} step={0.05}/></Field>
      </div>
      <div className="mt-3 text-xs text-stone-500">Lockup periods detected: {sum(results.lockup)} / {results.lockup.length}</div>
    </Section>
  </div>;
}

function ControlAccountsTab({model, setModel, results}){
  const ca = model.controlAccounts;
  const setCA = patch => setModel({...model, controlAccounts:{...ca, ...patch}});
  const updateMMR = (i, patch) => setCA({mmrTargetSchedule: ca.mmrTargetSchedule.map((r,idx)=>idx===i?{...r,...patch}:r)});
  return <div>
    <Section title="DSRA — Debt Service Reserve Account">
      <div className="grid grid-cols-2 gap-4"><Field label="Months of DS Held"><NumInput value={ca.dsraMonthsDS} onChange={v=>setCA({dsraMonthsDS:v})} suffix="mo"/></Field></div>
    </Section>
    <Section title="O&M Reserve">
      <div className="grid grid-cols-2 gap-4"><Field label="Months of Opex Held"><NumInput value={ca.omReserveMonths} onChange={v=>setCA({omReserveMonths:v})} suffix="mo"/></Field></div>
    </Section>
    <Section title="Ramp-up Reserve">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Initial Funding"><NumInput value={ca.rampUpReserveAmount} onChange={v=>setCA({rampUpReserveAmount:v})} prefix="$" step={1000000}/></Field>
        <Field label="Release Over (yrs)"><NumInput value={ca.rampUpReleaseYears} onChange={v=>setCA({rampUpReleaseYears:v})} suffix="yr"/></Field>
      </div>
    </Section>
    <Section title="MMR — Major Maintenance Reserve" subtitle="Stepped annual funding by op year." action={<button onClick={()=>setCA({mmrTargetSchedule:[...ca.mmrTargetSchedule,{yearStart:1,annualFunding:0}]})} className="text-xs text-amber-300">+ stage</button>}>
      <table className="w-full"><thead><tr><TH>Stage Start (Op. Year)</TH><TH className="text-right">Annual Funding</TH><TH></TH></tr></thead>
        <tbody>{ca.mmrTargetSchedule.map((s,i)=>(<tr key={i}>
          <TD><NumInput value={s.yearStart} onChange={v=>updateMMR(i,{yearStart:v})}/></TD>
          <TD className="text-right"><NumInput value={s.annualFunding} onChange={v=>updateMMR(i,{annualFunding:v})} prefix="$"/></TD>
          <TD><button onClick={()=>setCA({mmrTargetSchedule:ca.mmrTargetSchedule.filter((_,idx)=>idx!==i)})} className="text-xs text-rose-400">×</button></TD>
        </tr>))}</tbody></table>
    </Section>
    <Section title="Control Account Balances Over Time">
      <div style={{height:280}}>
        <ResponsiveContainer>
          <LineChart data={results.periods.map((p,i)=>({period:p.label,
            DSRA:Math.round(results.controlAccts.dsraTarget[i]/1e6),
            OMReserve:Math.round(results.controlAccts.omTarget[i]/1e6),
            RampUp:Math.round(results.controlAccts.rampUp[i]/1e6),
            MMR:Math.round(results.controlAccts.mmr[i]/1e6)}))}>
            <CartesianGrid stroke="#44403c" strokeDasharray="2 4"/>
            <XAxis dataKey="period" stroke="#a8a29e" tick={{fontSize:9}} interval={Math.max(0,Math.floor(results.periods.length/12))}/>
            <YAxis stroke="#a8a29e" tick={{fontSize:11}} label={{value:'$M',angle:-90,position:'insideLeft',fill:'#a8a29e',fontSize:11}}/>
            <Tooltip contentStyle={{background:'#1c1917',border:'1px solid #44403c',fontSize:12}}/>
            <Legend wrapperStyle={{fontSize:11}}/>
            <Line type="monotone" dataKey="DSRA" stroke="#fbbf24" strokeWidth={2} dot={false}/>
            <Line type="monotone" dataKey="OMReserve" stroke="#34d399" strokeWidth={2} dot={false}/>
            <Line type="monotone" dataKey="RampUp" stroke="#a78bfa" strokeWidth={2} dot={false}/>
            <Line type="monotone" dataKey="MMR" stroke="#fb923c" strokeWidth={2} dot={false}/>
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Section>
  </div>;
}

function OptimizerTab({model, setModel, results}){
  const o = model.optimizer;
  const setO = patch => setModel({...model, optimizer:{...o, ...patch}});
  const setCons = (k,v) => setO({constraints:{...o.constraints,[k]:v}});
  const setCascade = patch => setO({cascade:{...(o.cascade||{}), ...patch}});
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState(o.lastRun);
  const [jointOutput, setJointOutput] = useState(o.lastJointRun);
  const [cascadeOutput, setCascadeOutput] = useState(o.lastCascadeRun);
  const [autoCascadeOutput, setAutoCascadeOutput] = useState(o.lastAutoCascadeRun);
  const mode = o.mode || 'single';
  const updateJointTarget = (i, patch) => setO({jointTargets: o.jointTargets.map((t,idx)=>idx===i?{...t,...patch}:t)});
  const addJointTarget = () => setO({jointTargets:[...o.jointTargets, {instrumentId:model.financing.instruments[0]?.id||'', minDSCR:1.20, minLLCR:1.20}]});
  const removeJointTarget = (i) => setO({jointTargets:o.jointTargets.filter((_,idx)=>idx!==i)});

  const runSingle = () => {
    setRunning(true);
    setTimeout(()=>{
      const r = optimizeInstrument(model, o.targetInstrumentId, o.constraints);
      setOutput(r);
      setO({lastRun:{best:r.best, iterations:r.iterations}});
      setRunning(false);
    },50);
  };
  const runJoint = () => {
    setRunning(true);
    setTimeout(()=>{
      const r = optimizeJointTranches(model, o.jointTargets, o.constraints, o.plugInstrumentId);
      setJointOutput(r);
      setO({lastJointRun:{traces:r.traces, preGap:r.preGap, plugAdjustment:r.plugAdjustment, finalGap:r.finalGap, sizes: r.workingModel.financing.instruments.map(i=>({id:i.id,amount:i.amount}))}});
      setRunning(false);
    },50);
  };
  const runCascade = () => {
    setRunning(true);
    setTimeout(()=>{
      const r = runCascadeWaterfall(model, o.cascade || {});
      setCascadeOutput(r);
      setO({lastCascadeRun:{trace:r.trace, converged:r.converged, finalGap:r.finalGap,
        sizes: r.workingModel?.financing?.instruments?.map(i=>({id:i.id,amount:i.amount}))||[]}});
      setRunning(false);
    },50);
  };
  const runAutoCascade = () => {
    setRunning(true);
    setTimeout(()=>{
      const c = o.cascade || {};
      const ap = c.autoTifiaParams || {};
      const params = {
        tifiaInstrumentId: c.tifiaInstrumentId,
        tifiaEligibleCapexIds: c.tifiaEligibleCapexIds || [],
        pabInstrumentId: c.pabInstrumentId,
        plugInstrumentId: c.plugInstrumentId,
        deferYears: ap.deferYears,
        ioYears: ap.ioYears,
        testYearsBeforeMaturity: ap.testYearsBeforeMaturity,
        phase3Mode: ap.phase3Mode,
        minTifiaPct: ap.minTifiaPct,
        maxTifiaPct: ap.maxTifiaPct,
        minTotalDSCR: ap.minTotalDSCR,
        minSrDSCR: ap.minSrDSCR,
        minTifiaDSCR: ap.minTifiaDSCR,
      };
      const r = autoCascadeTifia(model, params);
      setAutoCascadeOutput(r);
      setO({lastAutoCascadeRun:{
        bestPct: r.best?.pct, bestTifia: r.best?.tifiaAmount, bestPab: r.best?.pabAmount,
        diagnosis: r.best?.phaseInfo?.diagnosis, converged: r.converged,
      }});
      setRunning(false);
    },50);
  };
  const applyAutoCascade = () => {
    if(!autoCascadeOutput || !autoCascadeOutput.best || !autoCascadeOutput.best.workingModel) return;
    setModel(autoCascadeOutput.best.workingModel);
  };
  const applySingle = () => {
    if(!output || !output.best) return;
    const m = JSON.parse(JSON.stringify(model));
    const inst = m.financing.instruments.find(i=>i.id===o.targetInstrumentId);
    inst.amount = Math.round(output.best);
    setModel(m);
  };
  const applyJoint = () => {
    if(!jointOutput || !jointOutput.workingModel) return;
    setModel(jointOutput.workingModel);
  };
  const applyCascade = () => {
    if(!cascadeOutput || !cascadeOutput.workingModel) return;
    setModel(cascadeOutput.workingModel);
  };

  return <div>
    <Section title="Optimizer Mode">
      <div className="flex gap-2 flex-wrap">
        <button onClick={()=>setO({mode:'single'})} className={`px-4 py-2 rounded text-xs uppercase tracking-wider border ${mode==='single'?'bg-amber-500/10 border-amber-500/50 text-amber-300':'bg-stone-900 border-stone-700 text-stone-400'}`}>Single Instrument</button>
        <button onClick={()=>setO({mode:'joint'})} className={`px-4 py-2 rounded text-xs uppercase tracking-wider border ${mode==='joint'?'bg-amber-500/10 border-amber-500/50 text-amber-300':'bg-stone-900 border-stone-700 text-stone-400'}`}>Joint Multi-Tranche</button>
        <button onClick={()=>setO({mode:'cascade'})} className={`px-4 py-2 rounded text-xs uppercase tracking-wider border ${mode==='cascade'?'bg-amber-500/10 border-amber-500/50 text-amber-300':'bg-stone-900 border-stone-700 text-stone-400'}`}>Cascade Waterfall</button>
      </div>
      <p className="text-xs text-stone-500 mt-3">
        {mode==='single' && 'Size one instrument against your binding constraints (binary search).'}
        {mode==='joint' && 'Size senior, then sub, sequentially against residual CFADS. Equity (or chosen plug) absorbs the funding gap.'}
        {mode==='cascade' && 'Cascade: TIFIA = % of eligible capex → PAB = max @ target DSCR → Equity = NPV(residual CF @ target IRR) → Plug absorbs gap. Iterates to convergence.'}
      </p>
    </Section>

    <Section title="Shared Constraints" subtitle="Apply across single and joint modes.">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Min Senior DSCR"><NumInput value={o.constraints.minSeniorDSCR} onChange={v=>setCons('minSeniorDSCR',v)} step={0.05}/></Field>
        <Field label="Min Total DSCR"><NumInput value={o.constraints.minTotalDSCR} onChange={v=>setCons('minTotalDSCR',v)} step={0.05}/></Field>
        <Field label="Min LLCR"><NumInput value={o.constraints.minLLCR} onChange={v=>setCons('minLLCR',v)} step={0.05}/></Field>
        <Field label="Min PLCR"><NumInput value={o.constraints.minPLCR} onChange={v=>setCons('minPLCR',v)} step={0.05}/></Field>
        <Field label="Enforce 1.0x overall obligation"><Toggle value={o.constraints.enforceOverallObligation} onChange={v=>setCons('enforceOverallObligation',v)} label={o.constraints.enforceOverallObligation?'ON':'OFF'}/></Field>
      </div>
    </Section>

    {mode==='single' && <>
      <Section title="Single-Instrument Sizing">
        <div className="grid grid-cols-2 gap-4 mb-4">
          <Field label="Target Instrument"><Select value={o.targetInstrumentId} onChange={v=>setO({targetInstrumentId:v})} options={model.financing.instruments.map(i=>i.id)}/></Field>
          <div className="text-xs text-stone-400 pt-6">{(()=>{
            const inst = model.financing.instruments.find(i=>i.id===o.targetInstrumentId);
            return inst ? `${inst.type} — current size ${fmt$(inst.amount)}` : '';
          })()}</div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={runSingle} disabled={running} className="px-4 py-2 bg-amber-500 text-stone-900 rounded text-sm font-medium hover:bg-amber-400 disabled:opacity-50">{running?'Optimizing…':'Run Optimizer'}</button>
          {output && output.best && <button onClick={applySingle} className="px-4 py-2 bg-emerald-500/20 text-emerald-300 border border-emerald-600 rounded text-sm hover:bg-emerald-500/30">Apply ({fmt$(output.best)})</button>}
        </div>
      </Section>
      {output && output.iterations && (
        <Section title="Optimization Trace">
          <div className="grid grid-cols-3 gap-3 mb-4">
            <Metric label="Optimal principal" value={fmt$(output.best)} accent="amber"/>
            <Metric label="Iterations" value={output.iterations.length} accent="stone"/>
            <Metric label="Final min DSCR" value={fmtRatio(output.bestResults?.minSeniorDSCR)} accent="green"/>
          </div>
          <div className="overflow-x-auto border border-stone-700/60 rounded max-h-72">
            <table className="w-full text-xs"><thead className="bg-stone-900 sticky top-0"><tr><TH>Iter</TH><TH className="text-right">Test Principal</TH><TH className="text-center">Feasible?</TH><TH className="text-right">Min DSCR</TH><TH className="text-right">Min LLCR</TH></tr></thead>
            <tbody>{output.iterations.map((it,i)=>(<tr key={i}>
              <TD>{it.iter+1}</TD><TD className="text-right">{fmt$(it.amount)}</TD>
              <TD className="text-center">{it.ok?<span className="text-emerald-400">✓</span>:<span className="text-rose-400">✗</span>}</TD>
              <TD className="text-right">{fmtRatio(it.minDSCR)}</TD><TD className="text-right">{fmtRatio(it.minLLCR)}</TD></tr>))}</tbody></table>
          </div>
        </Section>
      )}
    </>}

    {mode==='joint' && <>
      <Section title="Joint Multi-Tranche Targets" subtitle="Listed in seniority order (Senior → Sub). Each gets sized against residual CFADS at its target."
        action={<button onClick={addJointTarget} className="text-xs px-3 py-1.5 bg-amber-500/10 border border-amber-500/50 text-amber-300 rounded hover:bg-amber-500/20">+ Add Tranche</button>}>
        <table className="w-full">
          <thead><tr><TH>Instrument</TH><TH className="text-right">Min DSCR (own)</TH><TH className="text-right">Min LLCR (own)</TH><TH></TH></tr></thead>
          <tbody>{o.jointTargets.map((t,i)=>{
            const inst = model.financing.instruments.find(x=>x.id===t.instrumentId);
            return <tr key={i} className="hover:bg-stone-900/40">
              <TD><Select value={t.instrumentId} onChange={v=>updateJointTarget(i,{instrumentId:v})} options={model.financing.instruments.filter(x=>!['Grant','Paygo'].includes(x.seniority)).map(x=>x.id)}/>
                <div className="text-[10px] text-stone-500 mt-1">{inst?`${inst.type} (${inst.seniority}) · current ${fmt$(inst.amount)}`:'—'}</div>
              </TD>
              <TD className="text-right"><NumInput value={t.minDSCR} onChange={v=>updateJointTarget(i,{minDSCR:v})} step={0.05}/></TD>
              <TD className="text-right"><NumInput value={t.minLLCR} onChange={v=>updateJointTarget(i,{minLLCR:v})} step={0.05}/></TD>
              <TD><button onClick={()=>removeJointTarget(i)} className="text-xs text-rose-400 hover:text-rose-300">remove</button></TD>
            </tr>;
          })}</tbody>
        </table>
        <div className="grid grid-cols-2 gap-4 mt-4">
          <Field label="Funding-Gap Plug Instrument"><Select value={o.plugInstrumentId} onChange={v=>setO({plugInstrumentId:v})} options={model.financing.instruments.map(i=>i.id)}/></Field>
          <div className="text-xs text-stone-400 pt-6">After sizing tranches, this instrument is adjusted up or down so Sources = Uses.</div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={runJoint} disabled={running} className="px-4 py-2 bg-amber-500 text-stone-900 rounded text-sm font-medium hover:bg-amber-400 disabled:opacity-50">{running?'Optimizing…':'Run Joint Optimizer'}</button>
          {jointOutput && jointOutput.workingModel && <button onClick={applyJoint} className="px-4 py-2 bg-emerald-500/20 text-emerald-300 border border-emerald-600 rounded text-sm hover:bg-emerald-500/30">Apply Joint Sizing</button>}
        </div>
      </Section>
      {jointOutput && jointOutput.outerHistory && (
        <Section title="Joint Sizing Result" subtitle={jointOutput.converged ? `Converged in ${jointOutput.outerIterations} iteration(s)` : `Stopped at ${jointOutput.outerIterations} iterations (did not fully converge)`}>
          <div className="grid grid-cols-4 gap-3 mb-4">
            <Metric label="Outer iterations" value={jointOutput.outerIterations} accent={jointOutput.converged?'green':'amber'} sub={jointOutput.converged?'Converged':'Tolerance not met'}/>
            <Metric label="Total plug adjustment" value={fmt$(jointOutput.totalPlugAdjustment)} accent="violet" sub={`Δ ${model.financing.instruments.find(i=>i.id===o.plugInstrumentId)?.type||''}`}/>
            <Metric label="Final gap" value={fmt$(jointOutput.finalGap)} accent={Math.abs(jointOutput.finalGap)<1e6?'green':'red'} sub="Post-plug"/>
            <Metric label="Final min Sr DSCR" value={fmtRatio(jointOutput.finalResults?.minSeniorDSCR)} accent="green"/>
          </div>
          <div className="text-[11px] uppercase tracking-wider text-stone-400 mb-2">Iteration Convergence Trace</div>
          <div className="overflow-x-auto border border-stone-700/60 rounded mb-4">
            <table className="w-full text-xs">
              <thead className="bg-stone-900"><tr>
                <TH>Iter</TH>
                <TH className="text-right">Pre-plug Gap</TH>
                <TH className="text-right">Plug Δ</TH>
                <TH className="text-right">Post-plug Gap</TH>
                <TH className="text-right">Min Sr DSCR</TH>
                <TH className="text-right">Min LLCR</TH>
              </tr></thead>
              <tbody>{jointOutput.outerHistory.map((h,i)=>(
                <tr key={i} className="hover:bg-stone-900/40">
                  <TD>{h.outerIter}</TD>
                  <TD className="text-right text-amber-300">{fmt$(h.preGap)}</TD>
                  <TD className="text-right text-violet-300">{fmt$(h.plugAdjustment)}</TD>
                  <TD className={`text-right ${Math.abs(h.postGap)<1e6?'text-emerald-300':'text-rose-300'}`}>{fmt$(h.postGap)}</TD>
                  <TD className="text-right text-stone-300">{fmtRatio(h.minSeniorDSCR)}</TD>
                  <TD className="text-right text-stone-300">{fmtRatio(h.minLLCR)}</TD>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="text-[11px] uppercase tracking-wider text-stone-400 mb-2">Final Tranche Sizes</div>
          <table className="w-full">
            <thead><tr><TH>Instrument</TH><TH>Seniority</TH><TH className="text-right">Sized to</TH><TH className="text-right">Bisection Iters</TH></tr></thead>
            <tbody>{jointOutput.traces.map((t,i)=>{
              const inst = jointOutput.workingModel.financing.instruments.find(x=>x.id===t.instrumentId);
              return <tr key={i} className="hover:bg-stone-900/40">
                <TD mono={false} className="text-stone-200">{inst?inst.type:t.instrumentId}</TD>
                <TD mono={false} className="text-stone-400">{t.seniority||'—'}</TD>
                <TD className="text-right text-amber-300">{t.best?fmt$(t.best):(t.error||'—')}</TD>
                <TD className="text-right text-stone-400">{t.iterations||0}</TD>
              </tr>;
            })}</tbody>
          </table>
        </Section>
      )}
    </>}

    {mode==='cascade' && (()=>{
      const c = o.cascade || {};
      const ap = c.autoTifiaParams || {};
      const setAuto = patch => setCascade({autoTifiaParams: {...ap, ...patch}});
      const eligibleIds = c.tifiaEligibleCapexIds || [];
      const toggleEligible = (id) => {
        const newIds = eligibleIds.includes(id) ? eligibleIds.filter(x=>x!==id) : [...eligibleIds, id];
        setCascade({tifiaEligibleCapexIds: newIds});
      };
      // Eligible cost preview from current model
      let eligiblePreview = 0;
      if(results && results.capexSched){
        for(const id of eligibleIds){
          eligiblePreview += sum(results.capexSched.byItem[id] || []);
        }
      }
      const tifiaPreview = eligiblePreview * (c.tifiaPercentage || 0);
      return <>
        <Section title="Auto-Optimize TIFIA %"
          subtitle="When ON: binary-search the maximum TIFIA % such that (a) the 50% balance test passes by construction (phases built deterministically), (b) Sr DSCR ≥ floor, and (c) TIFIA effective DSCR ≥ floor. Auto-cascade overrides the manual TIFIA % in Step 1 below."
          action={<Toggle value={c.autoOptimizeTifia} onChange={v=>setCascade({autoOptimizeTifia:v})} label={c.autoOptimizeTifia?'AUTO ON':'AUTO OFF'}/>}>
          {c.autoOptimizeTifia && <div className="space-y-4">
            <div className="grid grid-cols-4 gap-3">
              <Field label="Defer Years (CapI)"><NumInput value={ap.deferYears} onChange={v=>setAuto({deferYears:v})} step={1} suffix="y"/></Field>
              <Field label="IO Years"><NumInput value={ap.ioYears} onChange={v=>setAuto({ioYears:v})} step={1} suffix="y"/></Field>
              <Field label="Test Point (yrs before maturity)"><NumInput value={ap.testYearsBeforeMaturity} onChange={v=>setAuto({testYearsBeforeMaturity:v})} step={1} suffix="y"/></Field>
              <Field label="Phase 3 Mode"><Select value={ap.phase3Mode} onChange={v=>setAuto({phase3Mode:v})} options={['sculpt','annuity']}/></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Min TIFIA % (search floor)"><NumInput value={ap.minTifiaPct} onChange={v=>setAuto({minTifiaPct:v})} step={0.01} suffix="%"/></Field>
              <Field label="Max TIFIA % (statute cap)"><NumInput value={ap.maxTifiaPct} onChange={v=>setAuto({maxTifiaPct:v})} step={0.01} suffix="%"/></Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Min Total DSCR (Sr + TIFIA)" hint="Binds TIFIA sizing"><NumInput value={ap.minTotalDSCR} onChange={v=>setAuto({minTotalDSCR:v})} step={0.05}/></Field>
              <Field label="Min Senior DSCR" hint="Binds PAB sizing"><NumInput value={ap.minSrDSCR} onChange={v=>setAuto({minSrDSCR:v})} step={0.05}/></Field>
              <Field label="Min TIFIA Eff DSCR" hint="(CFADS−SrDS)/TIFIA DS"><NumInput value={ap.minTifiaDSCR} onChange={v=>setAuto({minTifiaDSCR:v})} step={0.05}/></Field>
            </div>
            <div className="bg-stone-900/40 border border-stone-700/60 rounded p-3 text-xs text-stone-400 space-y-1">
              <div><span className="text-amber-300">Phase 1 — Defer (CapI):</span> {ap.deferYears}y · interest capitalizes into balance</div>
              <div><span className="text-amber-300">Phase 2 — IO:</span> {ap.ioYears}y · pay interest only</div>
              <div><span className="text-amber-300">Phase 3 — {ap.phase3Mode === 'annuity' ? 'Annuity (level pmt)' : 'Sculpt (binary-searched DSCR)'}:</span> from period {(ap.deferYears+ap.ioYears)*(model.general.periodsPerYear||2)} to test point · targets balance = 50% of original P at test point</div>
              <div><span className="text-amber-300">Phase 4 — Level:</span> {ap.testYearsBeforeMaturity}y · amortize remaining 50% to zero by maturity</div>
              {ap.phase3Mode === 'sculpt' && <div className="text-stone-500">If sculpt is infeasible (TIFIA too large for CFADS), phase 3 falls back to annuity automatically.</div>}
            </div>
            <div className="flex items-center gap-3">
              <button onClick={runAutoCascade} disabled={running}
                className="px-4 py-2 bg-amber-500 text-stone-900 rounded text-sm font-medium hover:bg-amber-400 disabled:opacity-50">
                {running ? 'Running auto-cascade…' : 'Run Auto-Cascade TIFIA Optimizer'}
              </button>
              {autoCascadeOutput && autoCascadeOutput.best && <button onClick={applyAutoCascade} className="px-4 py-2 bg-emerald-500/10 border border-emerald-500/50 text-emerald-300 rounded text-sm hover:bg-emerald-500/20">Apply Optimized Stack</button>}
            </div>
          </div>}
        </Section>

        {c.autoOptimizeTifia && autoCascadeOutput && (
          <Section title="Auto-Cascade Result" subtitle={autoCascadeOutput.converged?'Converged':'Did not converge'}>
            {autoCascadeOutput.error && <div className="p-3 bg-rose-900/20 border border-rose-700/50 rounded text-rose-300 text-sm mb-3">Error: {autoCascadeOutput.error}</div>}
            {autoCascadeOutput.best && (()=>{
              const b = autoCascadeOutput.best;
              return <>
                <div className="grid grid-cols-4 gap-3 mb-4">
                  <Metric label="Optimized TIFIA %" value={fmtPct(b.pct,2)} accent="amber" sub={b.pct >= (ap.maxTifiaPct-0.005) ? 'Ceiling reached' : 'Max feasible'}/>
                  <Metric label="TIFIA Principal" value={fmt$(b.tifiaAmount)} accent="amber" sub={`of ${fmt$(b.eligibleCost)} eligible`}/>
                  <Metric label="Balance @ Test Point" value={fmt$(b.testBalAtPoint)} accent={b.testPassed?'green':'red'} sub={`50% target = ${fmt$(0.5*b.tifiaAmount)} · ${b.testPassed?'PASS':'FAIL'}`}/>
                  <Metric label="Funding Gap" value={fmt$(b.finalGap)} accent={Math.abs(b.finalGap)<1e6?'green':'amber'} sub="Post-plug"/>
                </div>
                <div className="grid grid-cols-4 gap-3 mb-4">
                  <Metric label="Min Total DSCR (Sr+TIFIA)" value={fmtRatio(b.minTotalDSCR)} accent={!b.minTotalDSCR || b.minTotalDSCR >= (ap.minTotalDSCR||1.10) ? 'green':'red'} sub={`floor ${(ap.minTotalDSCR||1.10).toFixed(2)}x · binds TIFIA`}/>
                  <Metric label="Min Senior DSCR" value={fmtRatio(b.minSrDSCR)} accent={b.minSrDSCR >= (ap.minSrDSCR||1.30) ? 'green':'red'} sub={`floor ${(ap.minSrDSCR||1.30).toFixed(2)}x`}/>
                  <Metric label="Min TIFIA Eff DSCR" value={fmtRatio(b.minTifiaEffDSCR)} accent={!b.minTifiaEffDSCR || b.minTifiaEffDSCR >= (ap.minTifiaDSCR||1.10) ? 'green':'red'} sub={`floor ${(ap.minTifiaDSCR||1.10).toFixed(2)}x`}/>
                  <Metric label="PAB Sized to" value={fmt$(b.pabAmount)} accent="amber" sub={`fills senior capacity`}/>
                </div>
                <div className="bg-stone-900/40 border border-amber-500/30 rounded p-3 mb-3">
                  <div className="text-[11px] uppercase tracking-wider text-amber-300 mb-1">Phase Structure (auto-generated)</div>
                  <div className="text-xs text-stone-300">{b.phaseInfo?.diagnosis}</div>
                  {b.phaseInfo?.fallbackUsed && <div className="text-xs text-amber-400 mt-1">⚠ Sculpt failed — fell back to annuity for phase 3</div>}
                  <div className="mt-2 flex h-6 rounded overflow-hidden border border-stone-700/60">
                    {(b.phaseInfo?.phases || []).map((p, idx) => {
                      const startP = idx === 0 ? 0 : (b.phaseInfo.phases[idx-1].endPeriod || 0);
                      const widthPct = ((p.endPeriod - startP) / Math.max(1, b.phaseInfo.phases[b.phaseInfo.phases.length-1].endPeriod)) * 100;
                      const colors = {defer:'#475569', io:'#fbbf24', sculpt:'#a78bfa', level:'#10b981', 'equal-principal':'#fb7185'};
                      return <div key={idx} style={{width:`${widthPct}%`, background:colors[p.regime]||'#666'}} className="flex items-center justify-center text-[9px] font-medium text-stone-950" title={`${p.regime} (${startP}→${p.endPeriod})`}>
                        {widthPct > 8 ? p.regime : ''}
                      </div>;
                    })}
                  </div>
                </div>
                <div className="text-[11px] uppercase tracking-wider text-stone-400 mb-2">Binary Search Trace</div>
                <div className="overflow-x-auto border border-stone-700/60 rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-stone-900"><tr>
                      <TH>Iter</TH><TH className="text-right">TIFIA %</TH><TH className="text-right">TIFIA $</TH><TH className="text-right">PAB $</TH>
                      <TH className="text-right">Min Total</TH><TH className="text-right">Min Sr</TH><TH className="text-right">TIFIA Eff</TH>
                      <TH className="text-right">Test Bal</TH><TH>Feasible</TH>
                    </tr></thead>
                    <tbody>{autoCascadeOutput.trace.map((t,i)=>(
                      <tr key={i} className={`hover:bg-stone-900/40 ${t.feasible?'':'opacity-60'}`}>
                        <TD>{t.iter}</TD>
                        <TD className="text-right text-amber-300">{fmtPct(t.pct,2)}</TD>
                        <TD className="text-right text-stone-300">{fmt$(t.tifiaAmount)}</TD>
                        <TD className="text-right text-stone-300">{fmt$(t.pabAmount)}</TD>
                        <TD className="text-right text-stone-300">{fmtRatio(t.minTotalDSCR)}</TD>
                        <TD className="text-right text-stone-300">{fmtRatio(t.minSrDSCR)}</TD>
                        <TD className="text-right text-stone-300">{fmtRatio(t.minTifiaEffDSCR)}</TD>
                        <TD className="text-right text-stone-400">{fmt$(t.testBalAtPoint)}</TD>
                        <TD className={t.feasible?'text-emerald-300':'text-rose-300'}>{t.feasible?'✓':'✗'}</TD>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </>;
            })()}
          </Section>
        )}

        {!c.autoOptimizeTifia && (
        <Section title="Step 1 — TIFIA Sizing (% of Eligible Capex)" subtitle="Select which capex line items are TIFIA-eligible. TIFIA sized as % of summed nominal capex. (TIFIA statute caps at 33% normally, 49% in some cases.)">
          <div className="grid grid-cols-2 gap-4 mb-4">
            <Field label="TIFIA Instrument"><Select value={c.tifiaInstrumentId} onChange={v=>setCascade({tifiaInstrumentId:v})} options={model.financing.instruments.filter(i=>i.type==='TIFIA Loan').map(i=>i.id)}/></Field>
            <Field label="Eligible Cost %"><NumInput value={c.tifiaPercentage} onChange={v=>setCascade({tifiaPercentage:v})} step={0.01} suffix="%"/></Field>
          </div>
          <div className="text-[11px] uppercase tracking-wider text-stone-400 mb-2">Capex Items — Toggle TIFIA-Eligible</div>
          <div className="grid grid-cols-3 gap-2 mb-4 max-h-64 overflow-y-auto border border-stone-700/60 rounded p-3 bg-stone-950">
            {model.capex.items.map(item => {
              const sel = eligibleIds.includes(item.id);
              const itemTotal = results?.capexSched?.byItem?.[item.id] ? sum(results.capexSched.byItem[item.id]) : item.base;
              return <label key={item.id} className={`flex items-center justify-between gap-2 p-2 rounded cursor-pointer border ${sel?'bg-amber-500/10 border-amber-500/40':'bg-stone-900/40 border-stone-800 hover:border-stone-700'}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <input type="checkbox" checked={sel} onChange={()=>toggleEligible(item.id)} className="accent-amber-500 flex-shrink-0"/>
                  <span className="text-xs text-stone-200 truncate">{item.label}</span>
                </div>
                <span className="text-[10px] text-stone-500 font-mono flex-shrink-0">{fmt$(itemTotal)}</span>
              </label>;
            })}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Metric label="Eligible Cost (preview)" value={fmt$(eligiblePreview)} accent="stone" sub={`${eligibleIds.length} of ${model.capex.items.length} items`}/>
            <Metric label="TIFIA Sized to (preview)" value={fmt$(tifiaPreview)} accent="amber" sub={`${(c.tifiaPercentage*100).toFixed(1)}% × eligible`}/>
          </div>
        </Section>

        <Section title="Step 2 — PAB Sizing (Target Senior DSCR)" subtitle="After TIFIA is sized, PAB is sized via binary search to the maximum that meets the target Senior DSCR.">
          <div className="grid grid-cols-2 gap-4">
            <Field label="PAB Instrument"><Select value={c.pabInstrumentId} onChange={v=>setCascade({pabInstrumentId:v})} options={model.financing.instruments.filter(i=>i.seniority==='Senior').map(i=>i.id)}/></Field>
            <Field label="Target Senior DSCR"><NumInput value={c.pabTargetDSCR} onChange={v=>setCascade({pabTargetDSCR:v})} step={0.05}/></Field>
          </div>
        </Section>

        <Section title="Step 3 — Equity Sizing (Target IRR from Residual CF)" subtitle="Equity sized as NPV of residual equity cashflow stream (CFADS − DS − reserves) discounted at target IRR. Sized to exactly earn that IRR from project cashflows.">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Equity Instrument"><Select value={c.equityInstrumentId} onChange={v=>setCascade({equityInstrumentId:v})} options={model.financing.instruments.filter(i=>i.seniority==='Equity').map(i=>i.id)}/></Field>
            <Field label="Target Equity IRR"><NumInput value={c.targetEquityIRR} onChange={v=>setCascade({targetEquityIRR:v})} step={0.005} suffix="%"/></Field>
          </div>
        </Section>

        <Section title="Step 4 — Plug Instrument (Funding Gap)" subtitle="Whatever gap remains between uses and sources flows into the plug. If plug is the same as the equity instrument, any plug above the IRR-sized equity will dilute the actual achieved IRR below target.">
          <div className="grid grid-cols-1 gap-4">
            <Field label="Plug Instrument"><Select value={c.plugInstrumentId} onChange={v=>setCascade({plugInstrumentId:v})} options={model.financing.instruments.map(i=>i.id)}/></Field>
          </div>
        </Section>

        <div className="flex items-center gap-3 mb-6">
          <button onClick={runCascade} disabled={running} className="px-4 py-2 bg-amber-500 text-stone-900 rounded text-sm font-medium hover:bg-amber-400 disabled:opacity-50">
            {running?'Running cascade…':'Run Cascade Waterfall'}
          </button>
          {cascadeOutput && cascadeOutput.workingModel && <button onClick={applyCascade} className="px-4 py-2 bg-emerald-500/10 border border-emerald-500/50 text-emerald-300 rounded text-sm hover:bg-emerald-500/20">Apply Sized Capital Stack</button>}
        </div>

        {cascadeOutput && cascadeOutput.trace && (
          <Section title="Cascade Result" subtitle={cascadeOutput.converged ? `Converged in ${cascadeOutput.outerIterations} iteration(s)` : `Stopped at ${cascadeOutput.outerIterations} (did not fully converge)`}>
            {cascadeOutput.error && <div className="p-3 bg-rose-900/20 border border-rose-700/50 rounded text-rose-300 text-sm mb-3">Error: {cascadeOutput.error}</div>}
            {cascadeOutput.trace.length > 0 && (()=>{
              const last = cascadeOutput.trace[cascadeOutput.trace.length-1];
              const irrDilution = last.actualEquityIRR != null && c.targetEquityIRR != null ? c.targetEquityIRR - last.actualEquityIRR : 0;
              return <>
                <div className="grid grid-cols-4 gap-3 mb-4">
                  <Metric label="TIFIA" value={fmt$(last.tifiaAmount)} accent="amber" sub={`${(c.tifiaPercentage*100).toFixed(1)}% of ${fmt$(last.eligibleCost)}`}/>
                  <Metric label="PAB" value={fmt$(last.pabAmount)} accent="amber" sub={`Min Sr DSCR ${fmtRatio(last.minSrDSCR)}`}/>
                  <Metric label="Equity (Total incl. Plug)" value={fmt$(last.totalEquity)} accent="violet" sub={`Of which IRR-sized: ${fmt$(last.equityFromIRR)}`}/>
                  <Metric label="Funding Gap (final)" value={fmt$(last.postGap)} accent={Math.abs(last.postGap)<1e6?'green':'red'} sub="Post-plug"/>
                </div>
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <Metric label="Target Equity IRR" value={fmtPct(c.targetEquityIRR,2)} accent="stone"/>
                  <Metric label="Actual Achieved IRR" value={fmtPct(last.actualEquityIRR,2)} accent={Math.abs(irrDilution)<0.005?'green':'amber'} sub={Math.abs(irrDilution)<0.005?'On target':`${irrDilution>0?'Diluted by':'Above target by'} ${fmtPct(Math.abs(irrDilution),2)}`}/>
                  <Metric label="Min LLCR" value={fmtRatio(last.minLLCR)} accent="stone"/>
                </div>
              </>;
            })()}
            <div className="text-[11px] uppercase tracking-wider text-stone-400 mb-2">Iteration Convergence Trace</div>
            <div className="overflow-x-auto border border-stone-700/60 rounded">
              <table className="w-full text-xs">
                <thead className="bg-stone-900"><tr>
                  <TH>Iter</TH>
                  <TH className="text-right">Eligible Cost</TH>
                  <TH className="text-right">TIFIA</TH>
                  <TH className="text-right">PAB</TH>
                  <TH className="text-right">Equity (IRR)</TH>
                  <TH className="text-right">Plug Δ</TH>
                  <TH className="text-right">Post Gap</TH>
                  <TH className="text-right">Actual IRR</TH>
                  <TH className="text-right">Min DSCR</TH>
                </tr></thead>
                <tbody>{cascadeOutput.trace.map((t,i)=>(
                  <tr key={i} className="hover:bg-stone-900/40">
                    <TD>{t.outer}</TD>
                    <TD className="text-right text-stone-300">{fmt$(t.eligibleCost)}</TD>
                    <TD className="text-right text-amber-300">{fmt$(t.tifiaAmount)}</TD>
                    <TD className="text-right text-amber-300">{fmt$(t.pabAmount)}</TD>
                    <TD className="text-right text-violet-300">{fmt$(t.equityFromIRR)}</TD>
                    <TD className="text-right text-stone-300">{fmt$(t.plugAmount)}</TD>
                    <TD className={`text-right ${Math.abs(t.postGap)<1e6?'text-emerald-300':'text-rose-300'}`}>{fmt$(t.postGap)}</TD>
                    <TD className="text-right text-stone-300">{fmtPct(t.actualEquityIRR,2)}</TD>
                    <TD className="text-right text-stone-300">{fmtRatio(t.minSrDSCR)}</TD>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Section>
        )}
        </>)}
      </>;
    })()}
  </div>;
}

function CFRow({label, data, positive, negative, bold, ratio, raw}){
  return <tr className={`hover:bg-stone-900/40 ${bold?'bg-stone-900/40':''}`}>
    <TD mono={false} className={`sticky left-0 bg-stone-950 ${bold?'text-stone-100 font-medium':'text-stone-300'}`}>{label}</TD>
    {data.map((v,i)=>(
      <TD key={i} className={`text-right ${positive?'text-emerald-300':''} ${negative?'text-rose-300':''} ${bold?'font-medium':''}`}>
        {ratio?(v==null||!isFinite(v)?'—':`${v.toFixed(2)}x`):raw?(v!=null?v.toLocaleString():'—'):fmt$(v)}
      </TD>))}
  </tr>;
}

function CashflowTab({model, results}){
  const periods = results.periods;
  return <div>
    <Section title={`Operating Cashflow — ${model.general.periodsPerYear===2?'Semi-Annual':'Annual'} (${model.general.useFiscalYear?`FY M${model.general.fyStartMonth}`:'CY'})`} subtitle={`${periods.length} periods · partial: ${periods.filter(p=>p.isPartial).length}`}>
      <div className="overflow-x-auto border border-stone-700/60 rounded">
        <table className="w-full text-xs">
          <thead className="bg-stone-900/80 sticky top-0"><tr>
            <TH className="sticky left-0 bg-stone-900 z-10 min-w-[240px]">Line Item ($ nominal)</TH>
            {periods.map((p,i)=><TH key={i} className="text-right">{p.label}{p.isPartial?'*':''}</TH>)}
          </tr></thead>
          <tbody>
            <CFRow label="Days in period" data={periods.map(p=>p.days)} raw/>
            <CFRow label="Toll Revenue" data={results.revSched.byPeriod} positive/>
            <CFRow label="Operating Expense" data={results.opexSched.byPeriod.map(v=>-v)} negative/>
            <CFRow label="CFADS" data={results.cfadsByPeriod} bold/>
            <CFRow label="Senior Interest" data={results.seniorInt.map(v=>-v)} negative/>
            <CFRow label="Senior Principal" data={results.seniorPri.map(v=>-v)} negative/>
            <CFRow label="Sub Interest" data={results.subInt.map(v=>-v)} negative/>
            <CFRow label="Sub Principal" data={results.subPri.map(v=>-v)} negative/>
            <CFRow label="Short-term DS" data={results.shortDS.map(v=>-v)} negative/>
            <CFRow label="Total Debt Service" data={results.totalDS.map(v=>-v)} bold negative/>
            <CFRow label="Equity CF (post-lockup)" data={results.equityCF} bold positive/>
            <CFRow label="Senior DSCR" data={results.seniorDSCR} ratio/>
            <CFRow label="Total DSCR" data={results.totalDSCR} ratio/>
            <CFRow label="Senior LLCR" data={results.llcrSenior} ratio/>
            <CFRow label="Overall Obligation Ratio" data={results.overallObligation} ratio/>
            <CFRow label="Lockup (1=triggered)" data={results.lockup} raw/>
            <CFRow label="Lockup Account — Deposits" data={results.lockupAcct.deposits.map(v=>-v)} negative/>
            <CFRow label="Lockup Account — Releases" data={results.lockupAcct.releases} positive/>
            <CFRow label="Lockup Account — Balance" data={results.lockupAcct.balance}/>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-stone-500 mt-2">* partial period (days less than full period).</p>
    </Section>
    <Section title="Capex Monthly Schedule (Construction)">
      <div className="overflow-x-auto border border-stone-700/60 rounded max-h-96">
        <table className="w-full text-xs">
          <thead className="bg-stone-900/80 sticky top-0"><tr>
            <TH className="sticky left-0 bg-stone-900 min-w-[220px]">Line Item</TH>
            {results.capexSched.monthly.map((_,i)=><TH key={i} className="text-right">M{i+1}</TH>)}
            <TH className="text-right">Total</TH>
          </tr></thead>
          <tbody>
            {model.capex.items.map(it=>{
              const arr = results.capexSched.byItem[it.id]; if(!arr) return null;
              return <tr key={it.id} className="hover:bg-stone-900/40">
                <TD mono={false} className="sticky left-0 bg-stone-950 text-stone-200">{it.label}</TD>
                {arr.map((v,i)=><TD key={i} className="text-right text-stone-300">{v>0?fmt$(v):'—'}</TD>)}
                <TD className="text-right text-amber-300 font-medium">{fmt$(sum(arr))}</TD>
              </tr>;
            })}
            <tr className="bg-stone-900/60">
              <TD mono={false} className="sticky left-0 bg-stone-900 font-medium text-stone-100">TOTAL CAPEX</TD>
              {results.capexSched.monthly.map((v,i)=><TD key={i} className="text-right text-amber-300 font-medium">{fmt$(v)}</TD>)}
              <TD className="text-right text-amber-300 font-bold">{fmt$(results.capexSched.totalNominal)}</TD>
            </tr>
            <tr className="bg-stone-900/40">
              <TD mono={false} className="sticky left-0 bg-stone-900 font-medium text-violet-200">TIFIA cap. interest</TD>
              {results.tifiaConstr.monthlyInterest.map((v,i)=><TD key={i} className="text-right text-violet-300">{v>0?fmt$(v):'—'}</TD>)}
              <TD className="text-right text-violet-300 font-bold">{fmt$(results.capitalizedTIFIAInterest)}</TD>
            </tr>
            <tr className="bg-stone-900/40">
              <TD mono={false} className="sticky left-0 bg-stone-900 font-medium text-stone-200">Non-TIFIA IDC</TD>
              {results.nonTIFIAIDCMonthly.map((v,i)=><TD key={i} className="text-right text-stone-300">{v>0?fmt$(v):'—'}</TD>)}
              <TD className="text-right text-stone-200 font-bold">{fmt$(results.nonTIFIAIDC)}</TD>
            </tr>
            <tr className="bg-stone-900/40">
              <TD mono={false} className="sticky left-0 bg-stone-900 font-medium text-emerald-200">Paygo contribution</TD>
              {results.paygoSched.monthly.map((v,i)=><TD key={i} className="text-right text-emerald-300">{v>0?fmt$(v):'—'}</TD>)}
              <TD className="text-right text-emerald-300 font-bold">{fmt$(results.paygoSched.total)}</TD>
            </tr>
          </tbody>
        </table>
      </div>
    </Section>
  </div>;
}

function SourcesUsesTab({model, results}){
  const uses = [];
  model.capex.items.forEach(it=>{ uses.push({label:it.label, amount:sum(results.capexSched.byItem[it.id]||[])}); });
  uses.push({label:'Capitalized TIFIA Interest', amount:results.capitalizedTIFIAInterest});
  uses.push({label:'Non-TIFIA IDC', amount:results.nonTIFIAIDC});
  uses.push({label:'Financing Fees', amount:results.financingFees});
  const totalUses = sum(uses.map(u=>u.amount));
  const sources = [];
  model.financing.instruments.forEach(i=>sources.push({label:i.type, amount:i.amount, seniority:i.seniority}));
  if(model.paygo.enabled) sources.push({label:'Paygo (Existing Net Revenues)', amount:results.paygoSched.total, seniority:'Paygo'});
  const totalSources = sum(sources.map(s=>s.amount));
  const gap = totalUses - totalSources;
  return <div className="grid grid-cols-2 gap-6">
    <Section title="Sources" subtitle={`Total: ${fmt$(totalSources)}`}>
      <table className="w-full"><thead><tr><TH>Instrument</TH><TH>Seniority</TH><TH className="text-right">Amount</TH><TH className="text-right">%</TH></tr></thead>
        <tbody>{sources.map((s,i)=>(<tr key={i} className="hover:bg-stone-900/40">
          <TD mono={false} className="text-stone-200">{s.label}</TD>
          <TD mono={false} className="text-stone-400">{s.seniority}</TD>
          <TD className="text-right text-amber-300">{fmt$(s.amount)}</TD>
          <TD className="text-right text-stone-400">{fmtPct(s.amount/totalSources)}</TD></tr>))}
          <tr className="bg-stone-900/60"><TD mono={false} className="font-medium text-stone-100">TOTAL</TD><TD></TD>
            <TD className="text-right text-amber-300 font-bold">{fmt$(totalSources)}</TD><TD className="text-right text-stone-400">100.0%</TD></tr>
        </tbody></table>
    </Section>
    <Section title="Uses" subtitle={`Total: ${fmt$(totalUses)}`}>
      <table className="w-full"><thead><tr><TH>Line Item</TH><TH className="text-right">Amount</TH><TH className="text-right">%</TH></tr></thead>
        <tbody>{uses.map((u,i)=>(<tr key={i} className="hover:bg-stone-900/40">
          <TD mono={false} className="text-stone-200">{u.label}</TD>
          <TD className="text-right text-amber-300">{fmt$(u.amount)}</TD>
          <TD className="text-right text-stone-400">{fmtPct(u.amount/totalUses)}</TD></tr>))}
          <tr className="bg-stone-900/60"><TD mono={false} className="font-medium text-stone-100">TOTAL</TD>
            <TD className="text-right text-amber-300 font-bold">{fmt$(totalUses)}</TD><TD className="text-right text-stone-400">100.0%</TD></tr>
        </tbody></table>
      <div className={`mt-4 p-3 rounded border ${Math.abs(gap)<1e6?'border-emerald-700/50 bg-emerald-900/10 text-emerald-300':'border-rose-700/50 bg-rose-900/10 text-rose-300'}`}>
        <div className="text-[10px] uppercase tracking-wider">Funding Balance</div>
        <div className="font-mono text-lg">{Math.abs(gap)<1e6?'Sources = Uses (balanced)':`Gap: ${fmt$(gap)} — ${gap>0?'shortfall':'excess'}`}</div>
      </div>
    </Section>
  </div>;
}

function DashboardTab({model, results}){
  const periods = results.periods;
  const cashflowData = periods.map((p,i)=>({period:p.label,
    Revenue:Math.round(results.revSched.byPeriod[i]/1e6),
    Opex:-Math.round(results.opexSched.byPeriod[i]/1e6),
    CFADS:Math.round(results.cfadsByPeriod[i]/1e6),
    DS:-Math.round(results.totalDS[i]/1e6),
    EquityCF:Math.round(results.equityCF[i]/1e6)}));
  // Chart 1: Debt Service vs Revenue (positive-stacked areas + revenue line)
  const debtServiceData = periods.map((p,i)=>({
    period: p.label,
    'Sr Interest':  +(results.seniorInt[i]/1e6).toFixed(2),
    'Sr Principal': +(results.seniorPri[i]/1e6).toFixed(2),
    'Sub Interest': +(results.subInt[i]/1e6).toFixed(2),
    'Sub Principal':+(results.subPri[i]/1e6).toFixed(2),
    'ST DS':        +(results.shortDS[i]/1e6).toFixed(2),
    'Revenue':      +(results.revSched.byPeriod[i]/1e6).toFixed(2),
  }));
  // Chart 2: Full operating cashflow stack — opex items + debt service + reserve net deposits, all positive
  const waterfallData = periods.map((p,i)=>{
    const row = { period: p.label };
    model.opex.items.forEach(it => {
      row[it.label] = +((results.opexSched.byItem[it.id]?.[i] || 0)/1e6).toFixed(2);
    });
    row['Sr Interest']  = +(results.seniorInt[i]/1e6).toFixed(2);
    row['Sr Principal'] = +(results.seniorPri[i]/1e6).toFixed(2);
    row['Sub Interest'] = +(results.subInt[i]/1e6).toFixed(2);
    row['Sub Principal']= +(results.subPri[i]/1e6).toFixed(2);
    row['ST DS']        = +(results.shortDS[i]/1e6).toFixed(2);
    const prev = (arr) => i > 0 ? arr[i-1] : 0;
    row['DSRA Deposit']    = +(Math.max(0, results.controlAccts.dsraTarget[i] - prev(results.controlAccts.dsraTarget))/1e6).toFixed(2);
    row['O&M Res Deposit'] = +(Math.max(0, results.controlAccts.omTarget[i]   - prev(results.controlAccts.omTarget))/1e6).toFixed(2);
    row['MMR Deposit']     = +(Math.max(0, results.controlAccts.mmr[i]        - prev(results.controlAccts.mmr))/1e6).toFixed(2);
    row['Lockup Deposit']  = +((results.lockupAcct.deposits[i] || 0)/1e6).toFixed(2);
    row['Revenue']         = +(results.revSched.byPeriod[i]/1e6).toFixed(2);
    return row;
  });
  const OPEX_COLORS  = ['#84cc16','#65a30d','#4ade80','#22c55e','#10b981','#059669','#047857','#065f46'];
  const DEBT_COLORS  = { 'Sr Interest':'#fbbf24', 'Sr Principal':'#f59e0b', 'Sub Interest':'#a78bfa', 'Sub Principal':'#8b5cf6', 'ST DS':'#fb7185' };
  const RES_COLORS   = { 'DSRA Deposit':'#94a3b8', 'O&M Res Deposit':'#64748b', 'MMR Deposit':'#475569', 'Lockup Deposit':'#7c3aed' };
  const dscrData = periods.map((p,i)=>({period:p.label,
    Senior:results.seniorDSCR[i] && isFinite(results.seniorDSCR[i])?results.seniorDSCR[i]:null,
    Total:results.totalDSCR[i] && isFinite(results.totalDSCR[i])?results.totalDSCR[i]:null,
    LLCR:results.llcrSenior[i] && isFinite(results.llcrSenior[i])?results.llcrSenior[i]:null,
    Overall:results.overallObligation[i] && isFinite(results.overallObligation[i])?results.overallObligation[i]:null}));
  const capexData = results.capexSched.monthly.map((v,i)=>({month:`M${i+1}`,Capex:Math.round(v/1e6)}));
  const sourcesData = [...model.financing.instruments.map(i=>({name:i.type, value:i.amount})),
    ...(model.paygo.enabled ? [{name:'Paygo', value:results.paygoSched.total}] : [])];
  const COLORS = ['#fbbf24','#fb923c','#f87171','#a78bfa','#34d399','#60a5fa','#f472b6','#94a3b8'];
  const tifiaInst = model.financing.instruments.find(i=>i.id===model.tifia.instrumentId);
  const tifiaWAL = tifiaInst ? results.walByInstrument[tifiaInst.id] : null;
  const lockupPeak = results.lockupAcct ? Math.max(...results.lockupAcct.balance) : 0;
  const lockupReleaseTotal = results.lockupAcct ? sum(results.lockupAcct.releases) : 0;
  return <div>
    <div className="grid grid-cols-4 gap-3 mb-6">
      <Metric label="Project IRR" value={fmtPct(results.projectIRR)} accent="amber" sub="Pre-financing"/>
      <Metric label="Equity IRR" value={fmtPct(results.equityIRR)} accent="green" sub="Post-financing, post-lockup"/>
      <Metric label="Min Senior DSCR" value={fmtRatio(results.minSeniorDSCR)} accent={results.minSeniorDSCR>=1.2?'green':'red'} sub={`Lockup ${model.tifia.lockupDSCR}x`}/>
      <Metric label="Min Senior LLCR" value={fmtRatio(results.minLLCR)} accent={results.minLLCR>=model.tifia.minLLCR?'green':'red'} sub={`Floor ${model.tifia.minLLCR}x`}/>
      <Metric label="TIFIA all-in rate" value={fmtPct(results.tifiaAllInRate,3)} accent="violet"/>
      <Metric label="TIFIA WAL" value={tifiaWAL?`${tifiaWAL.toFixed(2)}y`:'—'} accent="violet" sub={`Max ${model.tifia.maxWAL}y`}/>
      <Metric label="TIFIA effective DSCR" value={fmtRatio(results.tifiaEffectiveDSCR ?? results.tifiaTargetDSCR)} accent={results.tifiaEffectiveDSCR && results.tifiaTargetDSCR && results.tifiaEffectiveDSCR < results.tifiaTargetDSCR ? 'red' : 'violet'} sub={results.tifiaEffectiveDSCR && results.tifiaTargetDSCR && results.tifiaEffectiveDSCR < results.tifiaTargetDSCR ? `Target ${fmtRatio(results.tifiaTargetDSCR)} (50% test binding)` : `Target ${fmtRatio(results.tifiaTargetDSCR)}`}/>
      <Metric label="Lockup Acct Peak" value={fmt$(lockupPeak)} accent={lockupPeak>0?'red':'green'} sub={`${sum(results.lockup)} period(s) trapped · ${fmt$(lockupReleaseTotal)} released`}/>
      <Metric label="Total Capex (nominal)" value={fmt$(results.capexSched.totalNominal)} accent="amber"/>
      <Metric label="Total Uses" value={fmt$(results.totalUses)} accent="amber" sub={`Cap. TIFIA: ${fmt$(results.capitalizedTIFIAInterest)}`}/>
    </div>
    <Section title="Debt Service vs Revenue (per period)" subtitle="All debt principal and interest stacked positively. Revenue line should sit above the stack — the gap is CFADS net of debt service.">
      <div style={{height:340}}>
        <ResponsiveContainer>
          <ComposedChart data={debtServiceData}>
            <CartesianGrid stroke="#44403c" strokeDasharray="2 4"/>
            <XAxis dataKey="period" stroke="#a8a29e" tick={{fontSize:9}} interval={Math.max(0,Math.floor(periods.length/14))}/>
            <YAxis stroke="#a8a29e" tick={{fontSize:11}} label={{value:'$M',angle:-90,position:'insideLeft',fill:'#a8a29e',fontSize:11}}/>
            <Tooltip contentStyle={{background:'#1c1917',border:'1px solid #44403c',fontSize:12}} formatter={v=>`$${(v).toFixed(2)}M`}/>
            <Legend wrapperStyle={{fontSize:11}}/>
            <Area type="monotone" dataKey="Sr Interest"   stackId="ds" stroke={DEBT_COLORS['Sr Interest']}   fill={DEBT_COLORS['Sr Interest']}   fillOpacity={0.85}/>
            <Area type="monotone" dataKey="Sr Principal"  stackId="ds" stroke={DEBT_COLORS['Sr Principal']}  fill={DEBT_COLORS['Sr Principal']}  fillOpacity={0.85}/>
            <Area type="monotone" dataKey="Sub Interest"  stackId="ds" stroke={DEBT_COLORS['Sub Interest']}  fill={DEBT_COLORS['Sub Interest']}  fillOpacity={0.85}/>
            <Area type="monotone" dataKey="Sub Principal" stackId="ds" stroke={DEBT_COLORS['Sub Principal']} fill={DEBT_COLORS['Sub Principal']} fillOpacity={0.85}/>
            <Area type="monotone" dataKey="ST DS"         stackId="ds" stroke={DEBT_COLORS['ST DS']}         fill={DEBT_COLORS['ST DS']}         fillOpacity={0.85}/>
            <Line type="monotone" dataKey="Revenue" stroke="#10b981" strokeWidth={2.5} dot={false}/>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Section>

    <Section title="Operating Cashflow — Stacked Uses vs Revenue" subtitle="Every operating cost (line-item), every debt service component, and net reserve deposits stacked positively. Revenue line above stack = equity distribution available; revenue below stack = funding shortfall in that period.">
      <div style={{height:420}}>
        <ResponsiveContainer>
          <ComposedChart data={waterfallData}>
            <CartesianGrid stroke="#44403c" strokeDasharray="2 4"/>
            <XAxis dataKey="period" stroke="#a8a29e" tick={{fontSize:9}} interval={Math.max(0,Math.floor(periods.length/14))}/>
            <YAxis stroke="#a8a29e" tick={{fontSize:11}} label={{value:'$M',angle:-90,position:'insideLeft',fill:'#a8a29e',fontSize:11}}/>
            <Tooltip contentStyle={{background:'#1c1917',border:'1px solid #44403c',fontSize:11, maxHeight:380, overflow:'auto'}} formatter={v=>`$${(v).toFixed(2)}M`} itemSorter={(it)=> -it.value}/>
            <Legend wrapperStyle={{fontSize:10}} iconSize={8}/>
            {/* Opex items first (greens) */}
            {model.opex.items.map((it, idx) => (
              <Area key={it.id} type="monotone" dataKey={it.label} stackId="cf"
                stroke={OPEX_COLORS[idx % OPEX_COLORS.length]} fill={OPEX_COLORS[idx % OPEX_COLORS.length]} fillOpacity={0.85}/>
            ))}
            {/* Debt service (warm amber/violet/rose) */}
            <Area type="monotone" dataKey="Sr Interest"   stackId="cf" stroke={DEBT_COLORS['Sr Interest']}   fill={DEBT_COLORS['Sr Interest']}   fillOpacity={0.85}/>
            <Area type="monotone" dataKey="Sr Principal"  stackId="cf" stroke={DEBT_COLORS['Sr Principal']}  fill={DEBT_COLORS['Sr Principal']}  fillOpacity={0.85}/>
            <Area type="monotone" dataKey="Sub Interest"  stackId="cf" stroke={DEBT_COLORS['Sub Interest']}  fill={DEBT_COLORS['Sub Interest']}  fillOpacity={0.85}/>
            <Area type="monotone" dataKey="Sub Principal" stackId="cf" stroke={DEBT_COLORS['Sub Principal']} fill={DEBT_COLORS['Sub Principal']} fillOpacity={0.85}/>
            <Area type="monotone" dataKey="ST DS"         stackId="cf" stroke={DEBT_COLORS['ST DS']}         fill={DEBT_COLORS['ST DS']}         fillOpacity={0.85}/>
            {/* Reserve net deposits (slates + lockup violet) */}
            <Area type="monotone" dataKey="DSRA Deposit"    stackId="cf" stroke={RES_COLORS['DSRA Deposit']}    fill={RES_COLORS['DSRA Deposit']}    fillOpacity={0.85}/>
            <Area type="monotone" dataKey="O&M Res Deposit" stackId="cf" stroke={RES_COLORS['O&M Res Deposit']} fill={RES_COLORS['O&M Res Deposit']} fillOpacity={0.85}/>
            <Area type="monotone" dataKey="MMR Deposit"     stackId="cf" stroke={RES_COLORS['MMR Deposit']}     fill={RES_COLORS['MMR Deposit']}     fillOpacity={0.85}/>
            <Area type="monotone" dataKey="Lockup Deposit"  stackId="cf" stroke={RES_COLORS['Lockup Deposit']}  fill={RES_COLORS['Lockup Deposit']}  fillOpacity={0.85}/>
            {/* Revenue line on top */}
            <Line type="monotone" dataKey="Revenue" stroke="#10b981" strokeWidth={3} dot={false}/>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Section>
    <Section title="Coverage Ratios — DSCR / LLCR / Overall Obligation">
      <div style={{height:280}}>
        <ResponsiveContainer>
          <LineChart data={dscrData}>
            <CartesianGrid stroke="#44403c" strokeDasharray="2 4"/>
            <XAxis dataKey="period" stroke="#a8a29e" tick={{fontSize:9}} interval={Math.max(0,Math.floor(periods.length/14))}/>
            <YAxis stroke="#a8a29e" tick={{fontSize:11}}/>
            <Tooltip contentStyle={{background:'#1c1917',border:'1px solid #44403c',fontSize:12}} formatter={v=>v!=null?`${v.toFixed(2)}x`:'—'}/>
            <Legend wrapperStyle={{fontSize:11}}/>
            <ReferenceLine y={model.tifia.lockupDSCR} stroke="#f87171" strokeDasharray="4 4" label={{value:`Lockup ${model.tifia.lockupDSCR}x`,fill:'#f87171',fontSize:9}}/>
            <ReferenceLine y={1.0} stroke="#fb923c" strokeDasharray="4 4" label={{value:'1.0x',fill:'#fb923c',fontSize:9}}/>
            <Line type="monotone" dataKey="Senior" stroke="#fbbf24" strokeWidth={2} dot={false}/>
            <Line type="monotone" dataKey="Total" stroke="#a78bfa" strokeWidth={2} dot={false}/>
            <Line type="monotone" dataKey="LLCR" stroke="#34d399" strokeWidth={2} dot={false}/>
            <Line type="monotone" dataKey="Overall" stroke="#60a5fa" strokeWidth={2} strokeDasharray="3 3" dot={false}/>
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Section>
    <div className="grid grid-cols-2 gap-6">
      <Section title="Capex Curve (Monthly)">
        <div style={{height:240}}>
          <ResponsiveContainer><AreaChart data={capexData}>
            <CartesianGrid stroke="#44403c" strokeDasharray="2 4"/>
            <XAxis dataKey="month" stroke="#a8a29e" tick={{fontSize:10}} interval={Math.max(0,Math.floor(capexData.length/12))}/>
            <YAxis stroke="#a8a29e" tick={{fontSize:11}}/>
            <Tooltip contentStyle={{background:'#1c1917',border:'1px solid #44403c',fontSize:12}}/>
            <Area type="monotone" dataKey="Capex" stroke="#fbbf24" fill="#fbbf24" fillOpacity={0.3}/>
          </AreaChart></ResponsiveContainer>
        </div>
      </Section>
      <Section title="Sources of Capital">
        <div style={{height:240}}>
          <ResponsiveContainer><BarChart data={sourcesData} layout="vertical">
            <CartesianGrid stroke="#44403c" strokeDasharray="2 4"/>
            <XAxis type="number" stroke="#a8a29e" tick={{fontSize:11}} tickFormatter={v=>`$${(v/1e6).toFixed(0)}M`}/>
            <YAxis type="category" dataKey="name" stroke="#a8a29e" tick={{fontSize:10}} width={140}/>
            <Tooltip contentStyle={{background:'#1c1917',border:'1px solid #44403c',fontSize:12}} formatter={v=>fmt$(v)}/>
            <Bar dataKey="value" fill="#fbbf24">{sourcesData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}</Bar>
          </BarChart></ResponsiveContainer>
        </div>
      </Section>
    </div>
  </div>;
}

function SensCell({label, base, sens, isPct, isRatio}){
  const fmt = v => { if(v==null||!isFinite(v)) return '—'; if(isPct) return fmtPct(v); if(isRatio) return `${v.toFixed(2)}x`; return fmt$(v); };
  const delta = (sens||0)-(base||0);
  const isGood = delta>0;
  return <div className="bg-stone-950/60 p-2 rounded border border-stone-800">
    <div className="text-[9px] uppercase tracking-wider text-stone-500">{label}</div>
    <div className="font-mono text-sm text-stone-300">{fmt(base)} → <span className="text-amber-300">{fmt(sens)}</span></div>
    <div className={`text-[10px] font-mono ${isGood?'text-emerald-400':'text-rose-400'}`}>Δ {isPct?fmtPct(delta):isRatio?`${delta>=0?'+':''}${delta.toFixed(2)}x`:fmt$(delta)}</div>
  </div>;
}

function ChatTab({model, setModel, results}){
  const [messages, setMessages] = useState([
    {role:'assistant', content:"I can answer questions about this toll road model, run sensitivities, and propose scenario changes.\n\nTry:\n• \"What's driving min DSCR?\"\n• \"Run AADT -10% / opex +5% sensitivity\"\n• \"What if TIFIA size goes to $250M?\"\n• \"Explain why the 50% test is binding\""}
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);
  useEffect(()=>{ if(scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, loading]);
  const modelSummary = useMemo(()=>({
    general:model.general, waterfallMode:model.waterfall.mode,
    capexTotal:results.capexSched.totalNominal, totalUses:results.totalUses,
    capitalizedTIFIAInterest:results.capitalizedTIFIAInterest, tifiaAllInRate:results.tifiaAllInRate,
    sources:model.financing.instruments.map(i=>({id:i.id,type:i.type,amount:i.amount,seniority:i.seniority,rate:i.rate,tenor:i.tenorYears,repayment:i.repaymentStyle})),
    paygo:{enabled:model.paygo.enabled, total:results.paygoSched.total},
    revenueByPeriod:results.revSched.byPeriod.slice(0,10),
    opexByPeriod:results.opexSched.byPeriod.slice(0,10),
    cfadsByPeriod:results.cfadsByPeriod.slice(0,10),
    totalDSCR:results.totalDSCR.slice(0,10),
    seniorDSCR:results.seniorDSCR.slice(0,10),
    llcrSenior:results.llcrSenior.slice(0,10),
    overallObligation:results.overallObligation.slice(0,10),
    lockupPeriods:sum(results.lockup),
    equityIRR:results.equityIRR, projectIRR:results.projectIRR,
    minSeniorDSCR:results.minSeniorDSCR, avgSeniorDSCR:results.avgSeniorDSCR, minLLCR:results.minLLCR,
    tifia50Test:results.tifia50Test,
  }), [model, results]);
  const runSensitivity = (scenario)=>{
    const m = JSON.parse(JSON.stringify(model));
    if(scenario.aadtPct!=null) m.revenue.aadtY1 *= (1+scenario.aadtPct);
    if(scenario.tollPct!=null) m.revenue.vehicleClasses.forEach(c=>c.toll *= (1+scenario.tollPct));
    if(scenario.opexPct!=null) m.opex.items.forEach(i=>i.base *= (1+scenario.opexPct));
    if(scenario.capexPct!=null) m.capex.items.forEach(i=>i.base *= (1+scenario.capexPct));
    if(scenario.tifiaAmount!=null){ const t = m.financing.instruments.find(i=>i.id===m.tifia.instrumentId); if(t) t.amount = scenario.tifiaAmount; }
    if(scenario.treasuryRate!=null) m.tifia.treasuryRate = scenario.treasuryRate;
    return buildFullModel(m);
  };
  const send = async ()=>{
    if(!input.trim()||loading) return;
    const userMsg = {role:'user', content:input};
    const nm = [...messages, userMsg];
    setMessages(nm); setInput(''); setLoading(true);
    try {
      const systemPrompt = `You are a project finance analyst assistant in a US toll-road model.

Current model outputs:
${JSON.stringify(modelSummary, null, 2)}

You understand: period framework (semi-annual w/ FY/CY), TIFIA construction interest (actual/actual, semi-annual cap), 50% outstanding test, TIFIA tenor-based credit spread, LLCR/PLCR/WAL/DSCR constraints, equity lockups, control accounts (DSRA, O&M, ramp-up, MMR), paygo, debt-first vs opex-first waterfall, 1.0x overall obligation test.

You can return a sensitivity request as JSON when the user wants something calculated:
\`\`\`json
{"sensitivity": {"aadtPct": -0.10, "opexPct": 0.05, "tifiaAmount": null, "treasuryRate": null, "label": "AADT -10% / Opex +5%"}}
\`\`\`
Omit fields that don't apply. Be concise, numeric, use project-finance vernacular.`;
      const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          model:'claude-sonnet-4-20250514', max_tokens:1500, system:systemPrompt,
          messages: nm.filter(m=>m.role!=='system').map(m=>({role:m.role, content:m.content})),
        }),
      });
      const data = await apiResponse.json();
      const text = data.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n') || 'No response.';
      const match = text.match(/```json\s*([\s\S]*?)```/);
      let sensResults = null;
      if(match){
        try { const parsed = JSON.parse(match[1]);
          if(parsed.sensitivity){ const sr = runSensitivity(parsed.sensitivity); sensResults = {scenario:parsed.sensitivity, results:sr}; }
        } catch(e){}
      }
      setMessages([...nm, {role:'assistant', content:text, sensResults}]);
    } catch(e){ setMessages([...nm, {role:'assistant', content:`Error: ${e.message}`}]); }
    finally { setLoading(false); }
  };
  return <div className="flex flex-col h-[calc(100vh-200px)]">
    <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 mb-4 pr-2">
      {messages.map((m,i)=>(
        <div key={i} className={m.role==='user'?'ml-12':'mr-12'}>
          <div className="text-[10px] uppercase tracking-wider text-stone-500 mb-1">{m.role==='user'?'You':'Model Assistant'}</div>
          <div className={`p-3 rounded ${m.role==='user'?'bg-amber-500/10 border border-amber-500/30':'bg-stone-900/60 border border-stone-700/60'}`}>
            <div className="text-sm text-stone-100 whitespace-pre-wrap">{m.content.replace(/```json[\s\S]*?```/g,'').trim()}</div>
            {m.sensResults && (
              <div className="mt-3 pt-3 border-t border-stone-700/60">
                <div className="text-[10px] uppercase tracking-wider text-amber-300 mb-2">Scenario: {m.sensResults.scenario.label||'Custom'}</div>
                <div className="grid grid-cols-4 gap-2 text-xs">
                  <SensCell label="Equity IRR" base={results.equityIRR} sens={m.sensResults.results.equityIRR} isPct/>
                  <SensCell label="Project IRR" base={results.projectIRR} sens={m.sensResults.results.projectIRR} isPct/>
                  <SensCell label="Min Sr DSCR" base={results.minSeniorDSCR} sens={m.sensResults.results.minSeniorDSCR} isRatio/>
                  <SensCell label="Min LLCR" base={results.minLLCR} sens={m.sensResults.results.minLLCR} isRatio/>
                </div>
              </div>
            )}
          </div>
        </div>
      ))}
      {loading && <div className="mr-12"><div className="text-[10px] uppercase tracking-wider text-stone-500 mb-1">Model Assistant</div>
        <div className="p-3 rounded bg-stone-900/60 border border-stone-700/60 text-sm text-stone-400">Thinking…</div></div>}
    </div>
    <div className="flex gap-2 border-t border-stone-700/60 pt-3">
      <input type="text" value={input} onChange={e=>setInput(e.target.value)}
        onKeyDown={e=>{if(e.key==='Enter') send();}}
        placeholder="Ask anything about the model, or request a sensitivity…"
        className="flex-1 bg-stone-900 border border-stone-700 rounded px-3 py-2 text-sm text-stone-100 focus:outline-none focus:border-amber-500"/>
      <button onClick={send} disabled={loading||!input.trim()}
        className="px-4 py-2 bg-amber-500 text-stone-900 rounded text-sm font-medium hover:bg-amber-400 disabled:opacity-50">Send</button>
    </div>
  </div>;
}

// ---------- SENSITIVITY TAB ----------
// Two-way grid scenarios: pick X & Y variables, range, and an output metric. Cells are color-heatmapped.
function SensitivityTab({model, results}){
  const [xVar, setXVar] = useState('aadt');
  const [yVar, setYVar] = useState('opex');
  const [xMin, setXMin] = useState(-0.20);
  const [xMax, setXMax] = useState(0.20);
  const [xSteps, setXSteps] = useState(5);
  const [yMin, setYMin] = useState(-0.10);
  const [yMax, setYMax] = useState(0.10);
  const [ySteps, setYSteps] = useState(5);
  const [metric, setMetric] = useState('equityIRR');
  const [grid, setGrid] = useState(null);
  const [running, setRunning] = useState(false);

  const variables = {
    aadt:     {label:'AADT %',           unit:'%',   apply:(m,v)=>{ m.revenue.aadtY1 *= (1+v); }},
    toll:     {label:'Toll %',           unit:'%',   apply:(m,v)=> m.revenue.vehicleClasses.forEach(c=>c.toll*=(1+v))},
    opex:     {label:'Opex %',           unit:'%',   apply:(m,v)=> m.opex.items.forEach(i=>i.base*=(1+v))},
    capex:    {label:'Capex %',          unit:'%',   apply:(m,v)=> m.capex.items.forEach(i=>i.base*=(1+v))},
    treasury: {label:'Treasury (bps Δ)', unit:'bps', apply:(m,v)=>{ m.tifia.treasuryRate += v/10000; }},
    discount: {label:'Discount (bps Δ)', unit:'bps', apply:(m,v)=>{ m.general.discountRate += v/10000; }},
    tifiaAmt: {label:'TIFIA size %',     unit:'%',   apply:(m,v)=>{ const t=m.financing.instruments.find(i=>i.id===m.tifia.instrumentId); if(t) t.amount*=(1+v); }},
    pabAmt:   {label:'PAB size %',       unit:'%',   apply:(m,v)=>{ const p=m.financing.instruments.find(i=>i.type.includes('PABs')); if(p) p.amount*=(1+v); }},
    rampDelay:{label:'Ramp shock (Y1 only) %', unit:'%', apply:(m,v)=>{ if(m.revenue.aadtRamp.length) m.revenue.aadtRamp[0] *= (1+v); }},
    constrDelay:{label:'Construction months Δ', unit:'mo', apply:(m,v)=>{ m.general.constructionMonths = Math.max(6, Math.round(m.general.constructionMonths + v)); }},
  };
  const metrics = {
    equityIRR:    {label:'Equity IRR',        extract:r=>r.equityIRR,                          fmt:fmtPct,   betterHigher:true},
    projectIRR:   {label:'Project IRR',       extract:r=>r.projectIRR,                         fmt:fmtPct,   betterHigher:true},
    minSrDSCR:    {label:'Min Senior DSCR',   extract:r=>r.minSeniorDSCR,                      fmt:fmtRatio, betterHigher:true},
    avgSrDSCR:    {label:'Avg Senior DSCR',   extract:r=>r.avgSeniorDSCR,                      fmt:fmtRatio, betterHigher:true},
    minLLCR:      {label:'Min LLCR',          extract:r=>r.minLLCR,                            fmt:fmtRatio, betterHigher:true},
    tifiaEffDSCR: {label:'TIFIA Eff. DSCR',   extract:r=>r.tifiaEffectiveDSCR??r.tifiaTargetDSCR, fmt:fmtRatio, betterHigher:true},
    fundingGap:   {label:'Funding Gap',       extract:r=>r.totalUses - r.totalSources,         fmt:fmt$,     betterHigher:false},
    totalUses:    {label:'Total Uses',        extract:r=>r.totalUses,                          fmt:fmt$,     betterHigher:false},
    lockupPeriods:{label:'# Lockup Periods',  extract:r=>sum(r.lockup),                        fmt:v=>v!=null?v.toString():'—', betterHigher:false},
  };

  const fmtAxis = (v, unit) => unit==='%' ? `${(v*100).toFixed(1)}%` : unit==='bps' ? `${(v).toFixed(0)}bps` : unit==='mo' ? `${v>=0?'+':''}${v.toFixed(0)}mo` : v.toFixed(2);

  const run = () => {
    setRunning(true);
    setTimeout(()=>{
      const xs = xSteps<=1 ? [xMin] : Array.from({length:xSteps},(_,i)=>xMin+(xMax-xMin)*i/(xSteps-1));
      const ys = ySteps<=1 ? [yMin] : Array.from({length:ySteps},(_,i)=>yMin+(yMax-yMin)*i/(ySteps-1));
      const data = ys.map(yv=>xs.map(xv=>{
        const m = JSON.parse(JSON.stringify(model));
        variables[xVar].apply(m, xv);
        if(yVar !== xVar) variables[yVar].apply(m, yv);
        try { const r = buildFullModel(m); return metrics[metric].extract(r); }
        catch(e) { return null; }
      }));
      const flat = data.flat().filter(v=>v!=null && isFinite(v));
      const min = flat.length ? Math.min(...flat) : 0;
      const max = flat.length ? Math.max(...flat) : 1;
      setGrid({ data, xs, ys, min, max });
      setRunning(false);
    }, 30);
  };

  // Base case for tornado
  const tornadoData = useMemo(()=>{
    if(!results) return null;
    const base = metrics[metric].extract(results);
    const shocks = [
      {key:'aadt',     down:-0.10, up:0.10, label:'AADT ±10%'},
      {key:'toll',     down:-0.10, up:0.10, label:'Toll ±10%'},
      {key:'opex',     down:-0.10, up:0.10, label:'Opex ∓10%'},  // sign flipped for "good" direction
      {key:'capex',    down:-0.10, up:0.10, label:'Capex ∓10%'},
      {key:'treasury', down:-50,   up:50,   label:'Treasury ±50bps'},
      {key:'discount', down:-50,   up:50,   label:'Discount ±50bps'},
    ];
    return shocks.map(s=>{
      const mDown = JSON.parse(JSON.stringify(model));
      variables[s.key].apply(mDown, s.down);
      const rDown = metrics[metric].extract(buildFullModel(mDown));
      const mUp = JSON.parse(JSON.stringify(model));
      variables[s.key].apply(mUp, s.up);
      const rUp = metrics[metric].extract(buildFullModel(mUp));
      return { label:s.label, base, down:rDown, up:rUp, downDelta:(rDown??0)-(base??0), upDelta:(rUp??0)-(base??0), range:Math.abs((rUp??0)-(rDown??0)) };
    }).sort((a,b)=>b.range-a.range);
  }, [model, metric, results]);

  return <div>
    <Section title="Two-Way Sensitivity Grid" subtitle="Pick two variables and an output metric. Each cell is an independent model run.">
      <div className="grid grid-cols-4 gap-3 mb-4">
        <Field label="X Variable"><Select value={xVar} onChange={setXVar} options={Object.keys(variables)}/></Field>
        <Field label="X Min"><NumInput value={xMin} onChange={setXMin} step={variables[xVar].unit==='bps'?5:variables[xVar].unit==='mo'?1:0.05}/></Field>
        <Field label="X Max"><NumInput value={xMax} onChange={setXMax} step={variables[xVar].unit==='bps'?5:variables[xVar].unit==='mo'?1:0.05}/></Field>
        <Field label="X Steps"><NumInput value={xSteps} onChange={setXSteps}/></Field>
        <Field label="Y Variable"><Select value={yVar} onChange={setYVar} options={Object.keys(variables)}/></Field>
        <Field label="Y Min"><NumInput value={yMin} onChange={setYMin} step={variables[yVar].unit==='bps'?5:variables[yVar].unit==='mo'?1:0.05}/></Field>
        <Field label="Y Max"><NumInput value={yMax} onChange={setYMax} step={variables[yVar].unit==='bps'?5:variables[yVar].unit==='mo'?1:0.05}/></Field>
        <Field label="Y Steps"><NumInput value={ySteps} onChange={setYSteps}/></Field>
        <Field label="Output Metric"><Select value={metric} onChange={setMetric} options={Object.keys(metrics)}/></Field>
      </div>
      <button onClick={run} disabled={running}
        className="px-4 py-2 bg-amber-500 text-stone-900 rounded text-sm font-medium hover:bg-amber-400 disabled:opacity-50">
        {running?'Running…':`Run Grid (${xSteps}×${ySteps} = ${xSteps*ySteps} runs)`}
      </button>
    </Section>

    {grid && (
      <Section title={`${metrics[metric].label} — Sensitivity Grid`} subtitle={`Cols: ${variables[xVar].label} · Rows: ${variables[yVar].label} · Colors: green=better, red=worse (${metrics[metric].betterHigher?'higher is better':'lower is better'})`}>
        <div className="overflow-x-auto border border-stone-700/60 rounded">
          <table className="w-full text-xs">
            <thead><tr>
              <TH className="bg-stone-900 text-stone-300">{variables[yVar].label}<span className="text-stone-600"> ↓</span> / {variables[xVar].label}<span className="text-stone-600"> →</span></TH>
              {grid.xs.map((v,i)=><TH key={i} className="text-right bg-stone-900 text-amber-300">{fmtAxis(v, variables[xVar].unit)}</TH>)}
            </tr></thead>
            <tbody>{grid.data.map((row, ri)=>(
              <tr key={ri}>
                <TD className="bg-stone-900 text-amber-300 font-medium">{fmtAxis(grid.ys[ri], variables[yVar].unit)}</TD>
                {row.map((cell, ci)=>{
                  let bg = 'rgba(64,64,64,0.2)';
                  if(cell != null && isFinite(cell) && grid.max > grid.min){
                    const norm = (cell - grid.min) / (grid.max - grid.min);
                    const score = metrics[metric].betterHigher ? norm : 1 - norm;
                    const r = Math.round(248 - score * 200);
                    const g = Math.round(80 + score * 180);
                    const b = Math.round(80 + score * 40);
                    bg = `rgba(${r}, ${g}, ${b}, 0.30)`;
                  }
                  return <TD key={ci} className="text-right text-stone-100" style={{background: bg}}>{metrics[metric].fmt(cell)}</TD>;
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div className="text-[10px] text-stone-500 mt-2">
          Range: {metrics[metric].fmt(grid.min)} (worst) → {metrics[metric].fmt(grid.max)} (best). {xSteps*ySteps} independent model runs.
        </div>
      </Section>
    )}

    {tornadoData && (
      <Section title={`Tornado — ${metrics[metric].label}`} subtitle="Single-variable shocks at ±10% (or ±50bps for rates). Ranked by impact range.">
        <div className="space-y-2">
          {tornadoData.map((t,i)=>{
            const maxRange = tornadoData[0].range || 1;
            const base = t.base ?? 0;
            const downPct = Math.abs(t.downDelta) / maxRange;
            const upPct = Math.abs(t.upDelta) / maxRange;
            return <div key={i} className="grid grid-cols-12 gap-2 items-center text-xs">
              <div className="col-span-3 text-stone-300">{t.label}</div>
              <div className="col-span-2 text-right font-mono text-rose-300">{metrics[metric].fmt(t.down)}</div>
              <div className="col-span-4 flex items-center justify-center h-6 relative bg-stone-900 rounded">
                <div className="absolute right-1/2 h-full bg-rose-500/40 border-r border-rose-400" style={{width:`${downPct*45}%`}}/>
                <div className="absolute left-1/2 h-full bg-emerald-500/40 border-l border-emerald-400" style={{width:`${upPct*45}%`}}/>
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-stone-500"/>
              </div>
              <div className="col-span-2 text-left font-mono text-emerald-300">{metrics[metric].fmt(t.up)}</div>
              <div className="col-span-1 text-right font-mono text-stone-400">Δ {metrics[metric].fmt(t.range)}</div>
            </div>;
          })}
        </div>
        <div className="text-[10px] text-stone-500 mt-3">Base: {metrics[metric].fmt(tornadoData[0]?.base)}. Bars scaled to widest-impact variable.</div>
      </Section>
    )}
  </div>;
}

// ---------- MARKDOWN RENDERER (for AI report display) ----------
function processInline(text){
  // Bold **text**, italic *text*, inline code `text`
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIdx = 0;
  let match;
  let key = 0;
  while((match = re.exec(text)) !== null){
    if(match.index > lastIdx) out.push(text.slice(lastIdx, match.index));
    const m = match[0];
    if(m.startsWith('**')) out.push(<strong key={key++} className="text-stone-100 font-medium">{m.slice(2,-2)}</strong>);
    else if(m.startsWith('`')) out.push(<code key={key++} className="bg-stone-800 px-1 py-0.5 rounded text-amber-300 text-xs">{m.slice(1,-1)}</code>);
    else out.push(<em key={key++} className="text-stone-200 italic">{m.slice(1,-1)}</em>);
    lastIdx = match.index + m.length;
  }
  if(lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

function renderMarkdown(text){
  if(!text) return null;
  const lines = text.split('\n');
  const elements = [];
  let listBuffer = [];
  let inTable = false, tableRows = [];
  const flushList = () => {
    if(listBuffer.length){
      elements.push(<ul key={`l${elements.length}`} className="list-disc list-outside ml-5 space-y-1 my-2 text-stone-300 text-sm">{listBuffer.map((it,i)=><li key={i}>{processInline(it)}</li>)}</ul>);
      listBuffer = [];
    }
  };
  const flushTable = () => {
    if(tableRows.length){
      const header = tableRows[0];
      const body = tableRows.slice(2); // skip separator row
      elements.push(<table key={`t${elements.length}`} className="w-full text-xs border border-stone-700/60 rounded my-3">
        <thead className="bg-stone-900"><tr>{header.map((c,i)=><th key={i} className="px-2 py-1.5 text-left text-stone-300 font-medium border-b border-stone-700">{c.trim()}</th>)}</tr></thead>
        <tbody>{body.map((row,ri)=><tr key={ri} className="border-b border-stone-800/40">{row.map((c,ci)=><td key={ci} className="px-2 py-1 text-stone-300 font-mono">{c.trim()}</td>)}</tr>)}</tbody>
      </table>);
      tableRows = []; inTable = false;
    }
  };
  lines.forEach((line, idx) => {
    if(line.startsWith('|')){
      const cells = line.split('|').slice(1, -1);
      tableRows.push(cells);
      inTable = true;
    } else {
      if(inTable) flushTable();
      if(line.startsWith('# '))      { flushList(); elements.push(<h1 key={idx} className="text-xl font-serif text-amber-300 mt-6 mb-3">{processInline(line.slice(2))}</h1>); }
      else if(line.startsWith('## ')){ flushList(); elements.push(<h2 key={idx} className="text-base font-serif text-amber-300 mt-5 mb-2 pb-1 border-b border-stone-700/60">{processInline(line.slice(3))}</h2>); }
      else if(line.startsWith('### ')){ flushList(); elements.push(<h3 key={idx} className="text-xs font-medium text-stone-100 mt-4 mb-2 uppercase tracking-wider">{processInline(line.slice(4))}</h3>); }
      else if(line.startsWith('- ') || line.startsWith('* ')){ listBuffer.push(line.slice(2)); }
      else if(line.trim() === ''){ flushList(); }
      else { flushList(); elements.push(<p key={idx} className="text-sm text-stone-300 my-2 leading-relaxed">{processInline(line)}</p>); }
    }
  });
  flushList();
  flushTable();
  return elements;
}

// ---------- VfM TAB ----------
function VfMTab({model, setModel, results}){
  const v = model.vfm;
  const setV = patch => setModel({...model, vfm:{...v, ...patch}});
  const vfm = useMemo(()=>buildVfMAnalysis(model, results), [model, results]);
  const [aiReport, setAiReport] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState(null);

  const updateRisk = (id, patch) => setV({riskRegister: v.riskRegister.map(r => r.id === id ? {...r, ...patch} : r)});
  const removeRisk = (id) => setV({riskRegister: v.riskRegister.filter(r => r.id !== id)});
  const addRisk = (phase) => {
    const id = 'r' + Math.random().toString(36).slice(2,7);
    setV({riskRegister: [...v.riskRegister, {
      id, category:'New Risk', phase, probability:0.25,
      impactLow:1_000_000, impactMostLikely:5_000_000, impactHigh:15_000_000,
      shareToPrivate:0.50, notes:''
    }]});
  };

  const generateReport = async () => {
    setReportLoading(true); setReportError(null);
    try {
      const summary = {
        project: model.general.projectName, state: model.general.state,
        construction_months: model.general.constructionMonths,
        operations_years: model.general.operationsYears,
        delivery_mode: vfm.isAvailabilityBased ? 'Availability-based' : 'Toll concession',
        psc_discount_rate: vfm.pscDiscountRate,
        psc_cost_premium: v.pscCostPremium,
        competitive_neutrality_pct: v.competitiveNeutralityPct,
        psc: {
          capex_npv: vfm.pscCapexNPV, opex_npv: vfm.pscOpexNPV,
          construction_risk_npv: vfm.pscConstrRiskNPV, ops_risk_npv: vfm.pscOpsRiskNPV,
          revenue_npv: vfm.pscRevenueNPV, comp_neutrality: vfm.compNeutralityAdj,
          net_cost_npv: vfm.pscNetCost,
        },
        p3: { net_cost_npv: vfm.p3NetCost, components: vfm.p3Components },
        vfm_absolute: vfm.vfm, vfm_pct: vfm.vfmPct,
        risk_register: v.riskRegister.map(r => ({
          category: r.category, phase: r.phase, probability: r.probability,
          pertMean: ((r.impactLow||0)+4*(r.impactMostLikely||0)+(r.impactHigh||0))/6,
          shareToPrivate: r.shareToPrivate, allocation: r.shareToPrivate >= 0.7 ? 'private' : r.shareToPrivate <= 0.3 ? 'public' : 'shared',
          mitigationCost: r.mitigationCost, mitigationOwner: r.mitigationOwner,
          probReduction: r.probReduction, impactReduction: r.impactReduction,
        })),
        risk_summary: {
          construction_pre_mit_ev: vfm.risks.construction.totalPre,
          construction_post_mit_ev: vfm.risks.construction.total,
          construction_public_ev: vfm.risks.construction.public,
          construction_private_ev: vfm.risks.construction.private,
          ops_pre_mit_annual_ev: vfm.risks.operations.annualPre,
          ops_post_mit_annual_ev: vfm.risks.operations.annual,
          ops_annual_public: vfm.risks.operations.annualPublic,
          ops_annual_private: vfm.risks.operations.annualPrivate,
        },
        mitigation: {
          construction_cost_onetime: vfm.mitigation.construction.totalAnnualOrOneTime,
          construction_public_cost: vfm.mitigation.construction.public,
          construction_private_cost: vfm.mitigation.construction.private,
          construction_benefit: vfm.mitigation.benefitConstr,
          ops_cost_annual: vfm.mitigation.operations.totalAnnualOrOneTime,
          ops_public_cost: vfm.mitigation.operations.public,
          ops_private_cost: vfm.mitigation.operations.private,
          ops_benefit_annual: vfm.mitigation.benefitOpsAnnual,
          total_mitigation_npv: vfm.mitigation.totalNPV,
          public_mitigation_npv: vfm.mitigation.publicNPV,
        },
        sensitivity_grid: vfm.sensitivityGrid,
        // financing context for qualitative discussion
        sources: model.financing.instruments.map(i => ({type:i.type, amount:i.amount, seniority:i.seniority})),
        equity_irr: results.equityIRR,
        min_sr_dscr: results.minSeniorDSCR,
      };
      const systemPrompt = `You are a senior infrastructure VfM analyst preparing a formal Value-for-Money assessment for a US toll road P3 procurement. Write a publication-quality report in markdown with this exact structure:

# Value for Money Assessment — ${model.general.projectName}

## 1. Executive Summary
Open with the headline finding: P3 VfM = $X (positive = P3 saves money). State delivery mode, PSC NPV, P3 NPV, and the implied % saving. Two paragraphs maximum.

## 2. Quantitative Findings
Present a structured cost build-up. Use a markdown table comparing PSC vs P3 line items (capex NPV, opex NPV, retained risks, transferred risks, competitive neutrality, revenue treatment, net cost). State the absolute and percentage VfM. Note the discount rate used.

## 3. Risk Transfer & Mitigation Assessment
Discuss the construction and operations risk register. Quantify pre-mitigation EV, mitigation cost, post-mitigation EV, and mitigation benefit. Identify which 3-4 risks dominate the EV (post-mit) and their allocation rationale. Comment on whether the mitigation strategy is cost-effective (mitigation cost vs benefit) and whether the risk transfer profile is appropriate (e.g., demand risk should sit with whoever can manage it; force majeure typically shared). Call out any risk where mitigation cost exceeds benefit — these are candidates to drop.

## 4. Qualitative Factors
Discuss factors not captured numerically: service quality, innovation potential, whole-life asset management, public acceptance, strategic alignment, lifecycle integration, hand-back condition. Be specific to a US toll road context.

## 5. Sensitivity & Robustness
Reference the sensitivity grid. Identify the discount rate and risk loading combinations where VfM flips sign. Comment on robustness of the conclusion.

## 6. Recommendation
Recommend P3 / PSC / further analysis. Be precise about residual conditions or risk mitigants that should be required.

Use exact dollar amounts from the data. Be analytically rigorous, not generic. Use US PF and procurement vernacular (PSC, retained vs transferred risk, EV, NPV, value-for-money threshold, risk-adjusted, competitive neutrality, shadow bid, optimism bias).

Here is the analysis input:
${JSON.stringify(summary, null, 2)}`;

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          model:'claude-sonnet-4-20250514', max_tokens: 4000,
          system: systemPrompt,
          messages: [{role:'user', content:'Please generate the VfM assessment now.'}]
        })
      });
      const data = await resp.json();
      const text = data.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n') || '';
      if(!text) throw new Error('Empty response from model');
      setAiReport(text);
    } catch(e){
      setReportError(e.message);
    } finally {
      setReportLoading(false);
    }
  };

  const constrRisks = v.riskRegister.filter(r=>r.phase==='construction');
  const opsRisks = v.riskRegister.filter(r=>r.phase==='operations');

  // Risk allocation chart data
  const riskChartData = [
    { phase:'Construction', Public: vfm.risks.construction.public/1e6, Private: vfm.risks.construction.private/1e6 },
    { phase:'Operations (Annual)', Public: vfm.risks.operations.annualPublic/1e6, Private: vfm.risks.operations.annualPrivate/1e6 },
  ];

  return <div>
    <Section title="PSC vs P3 Parameters" subtitle="The Public Sector Comparator (PSC) is what traditional delivery would cost. Both NPVs are taken at the PSC discount rate from the public sector's perspective.">
      <div className="grid grid-cols-3 gap-4 mb-4">
        <Field label="PSC Discount Rate"><NumInput value={v.pscDiscountRate} onChange={x=>setV({pscDiscountRate:x})} step={0.005} suffix="%"/></Field>
        <Field label="PSC Cost Premium" hint="Private-sector efficiency gap PSC misses"><NumInput value={v.pscCostPremium} onChange={x=>setV({pscCostPremium:x})} step={0.01} suffix="%"/></Field>
        <Field label="Competitive Neutrality %" hint="PSC tax/regulatory advantage adjustment"><NumInput value={v.competitiveNeutralityPct} onChange={x=>setV({competitiveNeutralityPct:x})} step={0.005} suffix="%"/></Field>
      </div>
    </Section>

    <Section title="P3 Delivery Mode" subtitle="Toll concession: private retains revenue, pays concession fee. Availability: public makes periodic availability payments.">
      <div className="flex items-center gap-3 mb-4">
        <Toggle value={!v.isAvailabilityBased} onChange={x=>setV({isAvailabilityBased:!x})} label="Toll Concession"/>
        <Toggle value={v.isAvailabilityBased} onChange={x=>setV({isAvailabilityBased:x})} label="Availability Payments"/>
      </div>
      {v.isAvailabilityBased ? (
        <div className="grid grid-cols-4 gap-4">
          <Field label="Annual AP (base)"><NumInput value={v.availabilityPaymentAnnual} onChange={x=>setV({availabilityPaymentAnnual:x})} prefix="$" step={1000000}/></Field>
          <Field label="AP Escalation"><NumInput value={v.availabilityEscalation} onChange={x=>setV({availabilityEscalation:x})} step={0.005} suffix="%"/></Field>
          <Field label="AP Start Year"><NumInput value={v.availabilityStartYear} onChange={x=>setV({availabilityStartYear:x})} suffix="yr"/></Field>
          <Field label="AP Tenor"><NumInput value={v.availabilityYears} onChange={x=>setV({availabilityYears:x})} suffix="yr"/></Field>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <Field label="Upfront Concession Fee"><NumInput value={v.upfrontConcessionFee} onChange={x=>setV({upfrontConcessionFee:x})} prefix="$" step={1000000}/></Field>
          <Field label="Revenue Share to Public"><NumInput value={v.revenueSharePct} onChange={x=>setV({revenueSharePct:x})} step={0.01} suffix="%"/></Field>
        </div>
      )}
    </Section>

    <Section title="Risk Register — Construction" subtitle={`${constrRisks.length} risks · Pre-Mit EV: ${fmt$(vfm.risks.construction.totalPre)} · Post-Mit EV: ${fmt$(vfm.risks.construction.total)} · Mit Cost: ${fmt$(vfm.mitigation.construction.totalAnnualOrOneTime)} (one-time)`}
      action={<button onClick={()=>addRisk('construction')} className="text-xs px-3 py-1.5 bg-amber-500/10 border border-amber-500/50 text-amber-300 rounded hover:bg-amber-500/20">+ Add Construction Risk</button>}>
      <RiskTable risks={constrRisks} update={updateRisk} remove={removeRisk}/>
    </Section>

    <Section title="Risk Register — Operations" subtitle={`${opsRisks.length} risks · Pre-Mit Annual EV: ${fmt$(vfm.risks.operations.annualPre)} · Post-Mit Annual EV: ${fmt$(vfm.risks.operations.annual)} · Annual Mit Cost: ${fmt$(vfm.mitigation.operations.totalAnnualOrOneTime)}`}
      action={<button onClick={()=>addRisk('operations')} className="text-xs px-3 py-1.5 bg-amber-500/10 border border-amber-500/50 text-amber-300 rounded hover:bg-amber-500/20">+ Add Ops Risk</button>}>
      <RiskTable risks={opsRisks} update={updateRisk} remove={removeRisk}/>
      <p className="text-[10px] text-stone-500 mt-2">Operations impacts and mitigation costs are interpreted as ANNUAL. NPV is computed over the full operations period at the PSC discount rate.</p>
    </Section>

    <Section title="Quantitative VfM Result">
      <div className="grid grid-cols-4 gap-3 mb-4">
        <Metric label="PSC Net Cost (NPV)" value={fmt$(vfm.pscNetCost)} accent="stone" sub={`Discount ${fmtPct(vfm.pscDiscountRate,2)}`}/>
        <Metric label="P3 Net Cost (NPV)"  value={fmt$(vfm.p3NetCost)}  accent="stone" sub={vfm.isAvailabilityBased?'Availability-based':'Toll concession'}/>
        <Metric label="VfM" value={fmt$(vfm.vfm)} accent={vfm.vfm>0?'green':'red'} sub={vfm.vfm>0?'P3 saves money':'PSC preferred'}/>
        <Metric label="VfM as % of PSC" value={fmtPct(vfm.vfmPct,1)} accent={vfm.vfm>0?'green':'red'}/>
      </div>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="bg-stone-900/40 border border-stone-700/60 rounded p-3">
          <div className="text-[11px] uppercase tracking-wider text-stone-400 mb-2">PSC Build-up</div>
          <table className="w-full text-xs"><tbody>
            <tr><TD mono={false} className="text-stone-300">Capex NPV</TD><TD className="text-right text-stone-200">{fmt$(vfm.pscCapexNPV)}</TD></tr>
            <tr><TD mono={false} className="text-stone-300">Opex NPV</TD><TD className="text-right text-stone-200">{fmt$(vfm.pscOpexNPV)}</TD></tr>
            <tr><TD mono={false} className="text-stone-300">Construction Risk NPV (post-mit)</TD><TD className="text-right text-rose-300">{fmt$(vfm.pscConstrRiskNPV)}</TD></tr>
            <tr><TD mono={false} className="text-stone-300">Operations Risk NPV (post-mit)</TD><TD className="text-right text-rose-300">{fmt$(vfm.pscOpsRiskNPV)}</TD></tr>
            <tr><TD mono={false} className="text-stone-300">Construction Mitigation NPV</TD><TD className="text-right text-violet-300">{fmt$(vfm.pscMitConstrNPV)}</TD></tr>
            <tr><TD mono={false} className="text-stone-300">Operations Mitigation NPV</TD><TD className="text-right text-violet-300">{fmt$(vfm.pscMitOpsNPV)}</TD></tr>
            <tr><TD mono={false} className="text-stone-300">Competitive Neutrality</TD><TD className="text-right text-rose-300">{fmt$(vfm.compNeutralityAdj)}</TD></tr>
            <tr><TD mono={false} className="text-stone-300">(−) Revenue NPV</TD><TD className="text-right text-emerald-300">({fmt$(vfm.pscRevenueNPV)})</TD></tr>
            <tr className="bg-stone-900/60"><TD mono={false} className="text-stone-100 font-medium">PSC Net Cost</TD><TD className="text-right text-amber-300 font-bold">{fmt$(vfm.pscNetCost)}</TD></tr>
          </tbody></table>
        </div>
        <div className="bg-stone-900/40 border border-stone-700/60 rounded p-3">
          <div className="text-[11px] uppercase tracking-wider text-stone-400 mb-2">P3 Build-up (Public Perspective)</div>
          <table className="w-full text-xs"><tbody>
            {vfm.isAvailabilityBased ? <>
              <tr><TD mono={false} className="text-stone-300">Availability Payments NPV</TD><TD className="text-right text-rose-300">{fmt$(vfm.p3Components.availabilityNPV)}</TD></tr>
            </> : <>
              <tr><TD mono={false} className="text-stone-300">Foregone Revenue NPV</TD><TD className="text-right text-rose-300">{fmt$(vfm.p3Components.foregoneRevNPV)}</TD></tr>
              <tr><TD mono={false} className="text-stone-300">(−) Upfront Concession Fee</TD><TD className="text-right text-emerald-300">({fmt$(vfm.p3Components.upfrontFee)})</TD></tr>
            </>}
            <tr><TD mono={false} className="text-stone-300">Retained Constr. Risk NPV</TD><TD className="text-right text-rose-300">{fmt$(vfm.p3Components.p3PublicConstrRiskNPV)}</TD></tr>
            <tr><TD mono={false} className="text-stone-300">Retained Ops Risk NPV</TD><TD className="text-right text-rose-300">{fmt$(vfm.p3Components.p3PublicOpsRiskNPV)}</TD></tr>
            <tr><TD mono={false} className="text-stone-300">Public Constr. Mitigation NPV</TD><TD className="text-right text-violet-300">{fmt$(vfm.p3Components.publicConstrMitNPV)}</TD></tr>
            <tr><TD mono={false} className="text-stone-300">Public Ops Mitigation NPV</TD><TD className="text-right text-violet-300">{fmt$(vfm.p3Components.publicOpsMitNPV)}</TD></tr>
            <tr className="bg-stone-900/60"><TD mono={false} className="text-stone-100 font-medium">P3 Net Cost</TD><TD className="text-right text-amber-300 font-bold">{fmt$(vfm.p3NetCost)}</TD></tr>
          </tbody></table>
        </div>
      </div>
      <div style={{height:200}}>
        <ResponsiveContainer>
          <BarChart data={riskChartData}>
            <CartesianGrid stroke="#44403c" strokeDasharray="2 4"/>
            <XAxis dataKey="phase" stroke="#a8a29e" tick={{fontSize:11}}/>
            <YAxis stroke="#a8a29e" tick={{fontSize:11}} label={{value:'$M (EV)',angle:-90,position:'insideLeft',fill:'#a8a29e',fontSize:11}}/>
            <Tooltip contentStyle={{background:'#1c1917',border:'1px solid #44403c',fontSize:12}} formatter={v=>`$${(v).toFixed(2)}M`}/>
            <Legend wrapperStyle={{fontSize:11}}/>
            <Bar dataKey="Public" stackId="r" fill="#fb923c"/>
            <Bar dataKey="Private" stackId="r" fill="#a78bfa"/>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Section>

    <Section title="VfM Sensitivity" subtitle="Discount rate × risk loading. Color: green = P3 wins, red = PSC wins.">
      <div className="overflow-x-auto border border-stone-700/60 rounded">
        <table className="w-full text-xs">
          <thead><tr>
            <TH className="bg-stone-900">Discount \\ Risk Mult.</TH>
            {[0.5, 0.75, 1.0, 1.25, 1.5].map(m=><TH key={m} className="text-right bg-stone-900 text-amber-300">{(m*100).toFixed(0)}%</TH>)}
          </tr></thead>
          <tbody>
            {vfm.sensitivityGrid.map((row,ri)=>(
              <tr key={ri}>
                <TD className="bg-stone-900 text-amber-300 font-medium">{fmtPct(row.discountRate,1)}</TD>
                {row.cells.map((c,ci)=>{
                  const positive = c.vfm > 0;
                  const intensity = Math.min(1, Math.abs(c.vfm) / Math.max(1, Math.abs(vfm.pscNetCost) * 0.3));
                  const bg = positive ? `rgba(34, 197, 94, ${0.10 + intensity*0.25})` : `rgba(248, 113, 113, ${0.10 + intensity*0.25})`;
                  return <TD key={ci} className="text-right" style={{background:bg}}>{fmt$(c.vfm)}</TD>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-stone-500 mt-2">Each cell is a full re-evaluation of PSC and P3 NPVs at the indicated discount rate and risk-impact multiplier.</p>
    </Section>

    <Section title="AI-Generated VfM Report" subtitle="Quantitative + qualitative assessment by Claude. Uses the full VfM dataset above as input.">
      <div className="flex items-center gap-3 mb-4">
        <button onClick={generateReport} disabled={reportLoading}
          className="px-4 py-2 bg-amber-500 text-stone-900 rounded text-sm font-medium hover:bg-amber-400 disabled:opacity-50">
          {reportLoading ? 'Generating…' : aiReport ? 'Regenerate Report' : 'Generate VfM Report'}
        </button>
        {aiReport && <button onClick={()=>{navigator.clipboard?.writeText(aiReport);}} className="text-xs px-3 py-1.5 bg-stone-900 border border-stone-700 text-stone-300 rounded hover:bg-stone-800">Copy markdown</button>}
      </div>
      {reportError && <div className="p-3 bg-rose-900/20 border border-rose-700/50 rounded text-rose-300 text-sm mb-3">Error: {reportError}</div>}
      {aiReport && (
        <div className="bg-stone-900/40 border border-stone-700/60 rounded p-6 max-w-4xl">
          {renderMarkdown(aiReport)}
        </div>
      )}
    </Section>
  </div>;
}

function RiskTable({risks, update, remove}){
  return <div className="overflow-x-auto">
    <table className="w-full text-xs">
      <thead><tr>
        <TH>Risk Category</TH>
        <TH className="text-right">Prob.</TH>
        <TH className="text-right">Low</TH>
        <TH className="text-right">Most Likely</TH>
        <TH className="text-right">High</TH>
        <TH className="text-right">Pre-Mit EV</TH>
        <TH className="text-right">→ Private %</TH>
        <TH className="text-right">Mit Cost</TH>
        <TH>Mit Owner</TH>
        <TH className="text-right">Δ Prob %</TH>
        <TH className="text-right">Δ Impact %</TH>
        <TH className="text-right">Post-Mit EV</TH>
        <TH>Notes</TH>
        <TH></TH>
      </tr></thead>
      <tbody>{risks.map(r=>{
        const pertPre = ((r.impactLow||0) + 4*(r.impactMostLikely||0) + (r.impactHigh||0)) / 6;
        const evPre = (r.probability||0) * pertPre;
        const pR = r.probReduction || 0, iR = r.impactReduction || 0;
        const pertPost = (((r.impactLow||0)*(1-iR)) + 4*((r.impactMostLikely||0)*(1-iR)) + ((r.impactHigh||0)*(1-iR))) / 6;
        const evPost = (r.probability||0) * (1-pR) * pertPost;
        const alloc = (r.shareToPrivate||0) >= 0.7 ? 'private' : (r.shareToPrivate||0) <= 0.3 ? 'public' : 'shared';
        const allocColor = alloc==='private' ? 'text-violet-300' : alloc==='public' ? 'text-orange-300' : 'text-stone-300';
        const benefit = evPre - evPost;
        return <tr key={r.id} className="hover:bg-stone-900/40">
          <TD mono={false}><TextInput value={r.category} onChange={x=>update(r.id,{category:x})}/></TD>
          <TD className="text-right"><NumInput value={r.probability} onChange={x=>update(r.id,{probability:x})} step={0.05} suffix="%"/></TD>
          <TD className="text-right"><NumInput value={r.impactLow} onChange={x=>update(r.id,{impactLow:x})} prefix="$" step={500000}/></TD>
          <TD className="text-right"><NumInput value={r.impactMostLikely} onChange={x=>update(r.id,{impactMostLikely:x})} prefix="$" step={500000}/></TD>
          <TD className="text-right"><NumInput value={r.impactHigh} onChange={x=>update(r.id,{impactHigh:x})} prefix="$" step={500000}/></TD>
          <TD className="text-right text-stone-400">{fmt$(evPre)}</TD>
          <TD className="text-right">
            <div className="flex items-center gap-2 justify-end">
              <NumInput value={r.shareToPrivate} onChange={x=>update(r.id,{shareToPrivate:x})} step={0.05}/>
              <span className={`text-[10px] uppercase tracking-wider ${allocColor}`}>{alloc}</span>
            </div>
          </TD>
          <TD className="text-right"><NumInput value={r.mitigationCost||0} onChange={x=>update(r.id,{mitigationCost:x})} prefix="$" step={100000}/></TD>
          <TD><Select value={r.mitigationOwner||'public'} onChange={x=>update(r.id,{mitigationOwner:x})} options={['public','private','shared']}/></TD>
          <TD className="text-right"><NumInput value={r.probReduction||0} onChange={x=>update(r.id,{probReduction:x})} step={0.05} suffix="%"/></TD>
          <TD className="text-right"><NumInput value={r.impactReduction||0} onChange={x=>update(r.id,{impactReduction:x})} step={0.05} suffix="%"/></TD>
          <TD className={`text-right font-medium ${benefit>0?'text-emerald-300':'text-amber-300'}`}>{fmt$(evPost)}</TD>
          <TD mono={false}><TextInput value={r.notes} onChange={x=>update(r.id,{notes:x})}/></TD>
          <TD><button onClick={()=>remove(r.id)} className="text-xs text-rose-400 hover:text-rose-300">×</button></TD>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

// ---------- MAIN APP ----------
const TABS = [
  {id:'general',label:'General'},{id:'capex',label:'Capex'},{id:'paygo',label:'Paygo'},
  {id:'revenue',label:'Revenue'},{id:'opex',label:'Opex'},{id:'financing',label:'Financing'},
  {id:'tifia',label:'TIFIA'},{id:'controls',label:'Control Accts'},{id:'optimizer',label:'Optimizer'},
  {id:'sensitivity',label:'Sensitivity'},{id:'vfm',label:'VfM'},
  {id:'cashflow',label:'Cashflow'},{id:'su',label:'S&U'},{id:'dashboard',label:'Dashboard'},{id:'chat',label:'Assistant'},
];

export default function App(){
  const [model, setModel] = useState(defaultModel);
  const [tab, setTab] = useState('dashboard');
  const [scenarioName, setScenarioName] = useState('');
  const [savedScenarios, setSavedScenarios] = useState([]);
  // ---- Scenario persistence (localStorage; works in any browser) ----
  const listScenarios = () => {
    const keys = [];
    for(let i=0; i<localStorage.length; i++){
      const k = localStorage.key(i);
      if(k && k.startsWith('scenario:')) keys.push(k);
    }
    return keys;
  };
  useEffect(()=>{ try { setSavedScenarios(listScenarios()); } catch(e){} }, []);
  const results = useMemo(()=>{ try { return buildFullModel(model); } catch(e){ console.error('Model error:', e); return null; } }, [model]);
  const saveScenario = ()=>{
    if(!scenarioName.trim()) return;
    try { localStorage.setItem(`scenario:${scenarioName}`, JSON.stringify(model));
      setSavedScenarios(listScenarios()); setScenarioName(''); } catch(e){ console.error(e); }
  };
  const loadScenario = (key)=>{
    try { const raw = localStorage.getItem(key); if(raw) setModel(JSON.parse(raw)); } catch(e){ console.error(e); }
  };
  if(!results) return <div className="min-h-screen bg-stone-950 text-rose-300 p-8 font-mono">Model error — check console.</div>;
  return (
    <div className="min-h-screen bg-stone-950 text-stone-100" style={{fontFamily:'IBM Plex Sans, system-ui, sans-serif'}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        body { background: #0c0a09; }
        .font-serif { font-family: 'Fraunces', serif; letter-spacing: -0.01em; }
        .font-mono { font-family: 'IBM Plex Mono', monospace; }
      `}</style>
      <header className="border-b border-stone-800 bg-stone-950/80 backdrop-blur sticky top-0 z-50">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-stone-500">Toll Road Project Finance · v2</div>
              <div className="font-serif text-lg text-stone-100">{model.general.projectName}</div>
            </div>
            <div className="hidden md:flex items-center gap-1 text-[11px] text-stone-500">
              <span className="px-2 py-0.5 bg-stone-900 rounded border border-stone-800">{model.general.state}</span>
              <span className="px-2 py-0.5 bg-stone-900 rounded border border-stone-800">{model.general.constructionMonths}mo construction</span>
              <span className="px-2 py-0.5 bg-stone-900 rounded border border-stone-800">{model.general.operationsYears}yr concession</span>
              <span className="px-2 py-0.5 bg-stone-900 rounded border border-stone-800">{model.general.periodsPerYear===2?'Semi-Annual':'Annual'} · {model.general.useFiscalYear?'FY':'CY'}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="text" value={scenarioName} onChange={e=>setScenarioName(e.target.value)} placeholder="Scenario name…"
              className="bg-stone-900 border border-stone-700 rounded px-2 py-1 text-xs text-stone-100 w-32 focus:outline-none focus:border-amber-500"/>
            <button onClick={saveScenario} className="text-xs px-3 py-1.5 bg-amber-500/10 border border-amber-500/50 text-amber-300 rounded hover:bg-amber-500/20">Save</button>
            {savedScenarios.length > 0 && (
              <select onChange={e=>loadScenario(e.target.value)} value=""
                className="bg-stone-900 border border-stone-700 rounded px-2 py-1.5 text-xs text-stone-100 focus:outline-none focus:border-amber-500">
                <option value="">Load…</option>
                {savedScenarios.map(k=><option key={k} value={k}>{k.replace('scenario:','')}</option>)}
              </select>
            )}
            <button onClick={()=>setModel(defaultModel())} className="text-xs px-3 py-1.5 bg-stone-900 border border-stone-700 text-stone-300 rounded hover:bg-stone-800">Reset</button>
          </div>
        </div>
        <nav className="px-6 flex gap-1 overflow-x-auto">
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)}
              className={`px-4 py-2 text-xs uppercase tracking-wider border-b-2 transition whitespace-nowrap ${tab===t.id?'border-amber-500 text-amber-300':'border-transparent text-stone-500 hover:text-stone-300'}`}>
              {t.label}
            </button>))}
        </nav>
      </header>
      <main className="p-6 max-w-[1600px] mx-auto">
        {tab==='general' && <GeneralTab model={model} setModel={setModel}/>}
        {tab==='capex' && <CapexTab model={model} setModel={setModel}/>}
        {tab==='paygo' && <PaygoTab model={model} setModel={setModel}/>}
        {tab==='revenue' && <RevenueTab model={model} setModel={setModel}/>}
        {tab==='opex' && <OpexTab model={model} setModel={setModel}/>}
        {tab==='financing' && <FinancingTab model={model} setModel={setModel}/>}
        {tab==='tifia' && <TIFIATab model={model} setModel={setModel} results={results}/>}
        {tab==='controls' && <ControlAccountsTab model={model} setModel={setModel} results={results}/>}
        {tab==='optimizer' && <OptimizerTab model={model} setModel={setModel} results={results}/>}
        {tab==='sensitivity' && <SensitivityTab model={model} results={results}/>}
        {tab==='vfm' && <VfMTab model={model} setModel={setModel} results={results}/>}
        {tab==='cashflow' && <CashflowTab model={model} results={results}/>}
        {tab==='su' && <SourcesUsesTab model={model} results={results}/>}
        {tab==='dashboard' && <DashboardTab model={model} results={results}/>}
        {tab==='chat' && <ChatTab model={model} setModel={setModel} results={results}/>}
      </main>
      <footer className="border-t border-stone-800 px-6 py-3 text-[10px] uppercase tracking-wider text-stone-600">
        v2 — Toll Road PF · Period framework · Full TIFIA · Paygo · Optimizer · 1.0x test · Client-side
      </footer>
    </div>
  );
}
