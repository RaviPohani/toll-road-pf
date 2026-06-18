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

const REPAYMENT_STYLES = ['Sculpted (target DSCR)','Level debt service','Equal principal','Bullet','IO then amortize','Deferred P&I then sculpted','Phased (multi-regime)','Custom schedule','Anticipation Note (GAN/BAN)'];
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
    // Government support: 'subsidy' = upfront viability gap grant; 'ap' = availability payments over time
    governmentSupportMode:'subsidy',
    apEscalation:0.025,         // annual escalation of the availability payment
    targetGearing:0.75,         // AP mode: max total debt as % of total uses
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
      {id:'tom',label:'Tolling O&M',base:2_800_000},
      {id:'clp',label:'Toll Collection — License Plate ($/txn)',base:0.45,perTxn:true,share:0.35},
      {id:'cvi',label:'Toll Collection — Video/Tag ($/txn)',base:0.08,perTxn:true,share:0.65},
    ],
  },
  financing: {
    instruments: [
      {id:'eq1',type:'Sponsor Equity',amount:120_000_000,rate:0,tenorYears:30,closeDate:'2026-07-01',seniority:'Equity',repaymentStyle:'Sculpted (target DSCR)',drawdownPriority:5,targetDSCR:1.30,ioYears:0,deferralYears:0,dayCount:'30/360',covenants:'Distribution lockup if TIFIA lockup triggered', issuanceCost:0, issuanceCostEscalation:0},
      {id:'sub1',type:'Upfront Subsidy',amount:0,rate:0,tenorYears:0,closeDate:'2026-07-01',seniority:'Grant',repaymentStyle:'Bullet',drawdownPriority:0,targetDSCR:0,ioYears:0,deferralYears:0,dayCount:'30/360',covenants:'Government viability gap funding — sized by Optimizer', issuanceCost:0, issuanceCostEscalation:0},
      {id:'fg1',type:'Federal Grant',amount:60_000_000,rate:0,tenorYears:0,closeDate:'2026-07-01',seniority:'Grant',repaymentStyle:'Bullet',drawdownPriority:1,targetDSCR:0,ioYears:0,deferralYears:0,dayCount:'30/360',covenants:'Federal cost-share requirements', issuanceCost:0, issuanceCostEscalation:0},
      {id:'sg1',type:'State Grant',amount:40_000_000,rate:0,tenorYears:0,closeDate:'2026-07-01',seniority:'Grant',repaymentStyle:'Bullet',drawdownPriority:1,targetDSCR:0,ioYears:0,deferralYears:0,dayCount:'30/360',covenants:'State match requirements', issuanceCost:0, issuanceCostEscalation:0},
      {id:'pab1',type:'PABs (Private Activity Bonds)',amount:280_000_000,rate:0.0525,tenorYears:30,closeDate:'2026-07-01',seniority:'Senior',repaymentStyle:'Level debt service',drawdownPriority:3,targetDSCR:1.35,ioYears:0,deferralYears:3,dayCount:'30/360',covenants:'Senior DSCR ≥1.20x; reserve fund equal to MADS', issuanceCost:4_500_000, issuanceCostEscalation:0.03, escrowRate:0.0425},
      {id:'tifia1',type:'TIFIA Loan',amount:200_000_000,rate:0.0410,tenorYears:35,closeDate:'2026-07-01',seniority:'Subordinate',repaymentStyle:'Phased (multi-regime)',drawdownPriority:4,targetDSCR:1.10,ioYears:0,deferralYears:5,dayCount:'Actual/Actual',covenants:'TIFIA springing lien; sub DSCR ≥1.10x after deferral', issuanceCost:1_750_000, issuanceCostEscalation:0.03,
        phases:[
          {regime:'defer',  endPeriod:10, targetDSCR:null},                                  // CapI 5y
          {regime:'io',     endPeriod:20, targetDSCR:null},                                  // IO 5y
          {regime:'level',  endPeriod:50, targetEndBalance:100_000_000, targetDSCR:null},    // Annuity to 50% of $200M @ test point (10y before maturity)
          {regime:'level',  endPeriod:70, targetEndBalance:0, targetDSCR:null}               // Level 10y to maturity, fully amortize
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
    // Major Maintenance: lumpy events pre-funded by smoothed MMR deposits, paid from reserve when due.
    mmEventSchedule: [
      {id:'rmm1', label:'Roadway MM', year:8,  amount:18_000_000},
      {id:'rmm2', label:'Roadway MM', year:16, amount:22_000_000},
      {id:'rmm3', label:'Roadway MM', year:24, amount:26_000_000},
      {id:'tmm1', label:'Tolling MM', year:6,  amount:8_000_000},
      {id:'tmm2', label:'Tolling MM', year:12, amount:9_000_000},
      {id:'tmm3', label:'Tolling MM', year:18, amount:10_000_000},
      {id:'tmm4', label:'Tolling MM', year:24, amount:11_000_000},
    ],
    mmInflation: 0.025,  // events escalate at this rate from FC
    // Funding mode per reserve: 'initial' (funded at SC from proceeds) vs 'deposits' (from operating cash)
    dsraFundingMode:'initial', omFundingMode:'deposits',
    dsraUseMaxAnnualDS:true,
  },
  optimizer: {
    mode:'joint',
    targetInstrumentId:'pab1',
    constraints:{minSeniorDSCR:1.30,minTotalDSCR:1.10,minLLCR:1.30,minPLCR:1.40,enforceOverallObligation:true},
    jointTargets:[
      {instrumentId:'pab1', minDSCR:1.30, minLLCR:1.30},
      {instrumentId:'tifia1', minDSCR:1.10, minLLCR:1.20},
    ],
    plugInstrumentId:'sub1',
    cascade: {
      // TIFIA sizing
      tifiaEnabled: true,
      tifiaInstrumentId:'tifia1',
      tifiaEligibleCapexIds:['eng','des','arc','mat','lab','uti','mob','oth','spv','row','ure'],
      tifiaPercentage:0.33,
      // PAB sizing
      pabInstrumentId:'pab1',
      pabTargetDSCR:1.30,
      // Equity sizing — to target IRR
      equityInstrumentId:'eq1',
      targetEquityIRR:0.12,
      // Plug — grants absorb residual gap after equity is sized
      plugInstrumentId:'sub1',
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
    pscUseLeverage: true,          // leveraged PSC: debt-financed to capacity, public funds the gap
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
    const phaseEnd = Math.min(phase.endPeriod || n, n);   // cap at n — prevents bullet when tenor > ops period
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
    else if(inst.repaymentStyle === 'Anticipation Note (GAN/BAN)'){
      // Back-calculate principal from anticipated future grant/bond amount.
      // Balance grows via CapI throughout tenor; bullet at maturity = anticipatedAmount.
      // Principal = PV(anticipatedAmount) = anticipated / (1+r)^n
      const anticipated = inst.anticipatedAmount || inst.amount;
      const tenorP = Math.min(Math.round((inst.tenorYears||2)*ppy), n);
      const computedPrincipal = (ratePer > 0 && tenorP > 0)
        ? anticipated / Math.pow(1 + ratePer, tenorP)
        : anticipated;
      // Update instrument amount so Sources/Uses reflects the actual draw
      inst.amount = computedPrincipal;
      const ganInterest = zeros(n), ganPrincipal = zeros(n), ganBalance = zeros(n);
      let bal = computedPrincipal;
      for(let i=0; i<n; i++){
        if(i < tenorP){
          bal *= (1 + ratePer);        // interest capitalises, no cash payment
          if(i === tenorP - 1){
            ganPrincipal[i] = bal;     // bullet = anticipated amount
            ganBalance[i] = 0;         // balance = 0 after bullet
          } else {
            ganBalance[i] = bal;
          }
        } // else balance stays 0
      }
      s = {interest: ganInterest, principal: ganPrincipal, balance: ganBalance};
    }
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
function buildControlAccounts(model, periods, ds, opex, debtSchedules, instruments){
  const ca = model.controlAccounts;
  const n = periods.length;
  const ppy = model.general.periodsPerYear;
  const dsra = zeros(n), om = zeros(n), ramp = zeros(n), mmr = zeros(n);

  // ── Per-instrument DSRA: each debt instrument carries its own reserve on its own DS ──
  // Skip short-term notes and grants/equity/paygo; one DSRA per long-term debt instrument.
  const buildDsraTarget = (dsArr) => {
    const tgt = zeros(n);
    if(ca.dsraUseMaxAnnualDS){
      let maxAnn = 0;
      for(let i=0;i<n;i+=ppy){ let yr=0; for(let k=0;k<ppy && i+k<n;k++) yr += dsArr[i+k]||0; if(yr>maxAnn) maxAnn=yr; }
      for(let i=0;i<n;i++){ let fut=0; for(let k=i+1;k<n;k++) fut += dsArr[k]||0; tgt[i] = fut>0 ? maxAnn : 0; }
    } else {
      for(let i=0;i<n;i++){ let s=0; for(let k=0;k<ppy && i+k<n;k++) s += dsArr[i+k]||0; tgt[i] = s*(ca.dsraMonthsDS/12); }
    }
    return tgt;
  };
  for(let i=0;i<n;i++){
    let nADS = 0, nAO = 0;
    for(let k=0;k<ppy && i+k<n;k++){ nADS += ds[i+k]||0; nAO += opex[i+k]||0; }
    dsra[i] = nADS * (ca.dsraMonthsDS/12);
    om[i] = nAO * (ca.omReserveMonths/12);
  }
  // DSRA target per period
  let dsraTargetLevel;
  if(ca.dsraUseMaxAnnualDS){
    // MADS basis: constant target = peak annual DS across whole tenor, held flat while debt is live
    let maxAnnualDS = 0;
    for(let i=0;i<n;i+=ppy){
      let yr = 0; for(let k=0;k<ppy && i+k<n;k++) yr += ds[i+k]||0;
      if(yr > maxAnnualDS) maxAnnualDS = yr;
    }
    dsraTargetLevel = maxAnnualDS;
    // Hold constant target while future debt service remains; release in final DS period
    for(let i=0;i<n;i++){
      let dsFuture = 0; for(let k=i+1;k<n;k++) dsFuture += ds[k]||0;
      dsra[i] = dsFuture > 0 ? maxAnnualDS : 0;
    }
  } else {
    // Months-of-DS basis: forward-looking target = next dsraMonthsDS of debt service
    dsraTargetLevel = Math.max(...dsra, 0);
  }
  let rb = ca.rampUpReserveAmount;
  const relPer = ca.rampUpReserveAmount / Math.max(1, ca.rampUpReleaseYears * ppy);
  for(let i=0;i<n;i++){ rb = Math.max(0, rb-relPer); ramp[i] = rb; }

  // ── MAJOR MAINTENANCE RESERVE: event-based pre-funding ──
  // Each MM event (escalated to its year) is pre-funded by smoothed deposits from start-of-ops
  // (or from the prior event) up to the event period. At the event, reserve pays the cost (release).
  const mmEvents = (ca.mmEventSchedule || []).map(e => {
    // Period index when the event occurs (year is in operating years, 1-based)
    const eventPeriod = Math.round((e.year - 1) * ppy);
    const escalated = e.amount * Math.pow(1 + (ca.mmInflation||0), e.year);  // escalate to event year
    return { ...e, eventPeriod, escalatedAmount: escalated };
  }).filter(e => e.eventPeriod >= 0 && e.eventPeriod < n)
    .sort((a,b) => a.eventPeriod - b.eventPeriod);

  const mmrDeposit = zeros(n), mmrRelease = zeros(n), mmrBalance = zeros(n);
  const mmEventCost = zeros(n);  // the actual lumpy MM payment, funded by release
  let mmrBal = 0;
  let prevEventPeriod = 0;
  for(const ev of mmEvents){
    // Smooth deposits from prevEventPeriod up to (but not including) this event period
    const fundStart = prevEventPeriod;
    const fundEnd = ev.eventPeriod;
    const periodsToFund = Math.max(1, fundEnd - fundStart);
    const need = ev.escalatedAmount;  // build from current balance up to this
    const perDeposit = (need - mmrBal) / periodsToFund;
    for(let i=fundStart; i<fundEnd; i++){
      if(i>=0 && i<n){ mmrDeposit[i] += Math.max(0, perDeposit); mmrBal += Math.max(0, perDeposit); mmrBalance[i] = mmrBal; }
    }
    // At the event period: pay the MM cost from reserve
    if(ev.eventPeriod>=0 && ev.eventPeriod<n){
      mmEventCost[ev.eventPeriod] += ev.escalatedAmount;
      mmrRelease[ev.eventPeriod] += Math.min(mmrBal, ev.escalatedAmount);
      mmrBal = Math.max(0, mmrBal - ev.escalatedAmount);
      mmrBalance[ev.eventPeriod] = mmrBal;
    }
    prevEventPeriod = ev.eventPeriod;
  }
  // Fill balance forward for periods after last event / between deposits
  for(let i=1;i<n;i++){ if(mmrBalance[i]===0 && mmrDeposit[i]===0 && mmrRelease[i]===0 && mmEventCost[i]===0) mmrBalance[i] = mmrBalance[i-1]; }
  // mmr target = balance trace
  for(let i=0;i<n;i++) mmr[i] = mmrBalance[i];

  // ── Reserve MOVEMENTS: deposits (outflow), releases (inflow), running balance ──
  // Both modes track the time-varying target with top-up deposits AND excess releases.
  // Difference: 'initial' funds the period-0 target from proceeds at SC (not a cash deposit);
  //             'deposits' funds everything from operating cash.
  const buildMovements = (target, mode) => {
    const deposit = zeros(n), release = zeros(n), balance = zeros(n);
    // First period where the reserve has a positive target = funding start
    let firstActive = target.findIndex(t => (t||0) > 0);
    if(firstActive < 0) firstActive = 0;
    const initialFund = mode === 'initial' ? (target[firstActive] || 0) : 0;
    let bal = mode === 'initial' ? initialFund : 0;
    for(let i=0;i<n;i++){
      const tgt = target[i] || 0;
      if(mode === 'initial' && i === firstActive){
        // balance already pre-funded from proceeds to the initial target; no cash deposit
        balance[i] = bal;
        continue;
      }
      // Both modes: top up when target rises, release when it falls
      if(bal < tgt){ deposit[i] = tgt - bal; bal = tgt; }
      else if(bal > tgt){ release[i] = bal - tgt; bal = tgt; }
      balance[i] = bal;
    }
    return { deposit, release, balance, initialFund };
  };

  const dsraMode = ca.dsraFundingMode || 'initial';
  const omMode = ca.omFundingMode || 'deposits';

  // ── Per-instrument DSRAs ──
  const dsraByInst = {};
  const dsraAggDeposit = zeros(n), dsraAggRelease = zeros(n), dsraAggBalance = zeros(n);
  let dsraTotalInitial = 0;
  if(debtSchedules && instruments){
    for(const inst of instruments){
      if(['Grant','Equity','Paygo','Short-term'].includes(inst.seniority)) continue;
      const sched = debtSchedules[inst.id];
      if(!sched) continue;
      const instDS = zeros(n);
      let hasDS = false;
      for(let i=0;i<n;i++){ instDS[i] = (sched.interest[i]||0) + (sched.principal[i]||0); if(instDS[i]>0) hasDS = true; }
      if(!hasDS) continue;
      const tgt = buildDsraTarget(instDS);
      const mov = buildMovements(tgt, dsraMode);
      dsraByInst[inst.id] = { label: inst.type, target: tgt, ...mov };
      for(let i=0;i<n;i++){
        dsraAggDeposit[i] += mov.deposit[i]||0;
        dsraAggRelease[i] += mov.release[i]||0;
        dsraAggBalance[i] += mov.balance[i]||0;
      }
      if(dsraMode === 'initial') dsraTotalInitial += mov.initialFund;
    }
  }
  // Aggregate DSRA used in waterfall/equity-CF
  const dsraMov = { deposit: dsraAggDeposit, release: dsraAggRelease, balance: dsraAggBalance, initialFund: dsraTotalInitial };

  const omMov = buildMovements(om, omMode);
  // MMR is always event-pre-funded from cash
  const mmrMov = { deposit: mmrDeposit, release: mmrRelease, balance: mmrBalance, initialFund: 0, eventCost: mmEventCost };
  // Ramp-up reserve: funded at SC, releases over rampUpReleaseYears
  const rampMov = { deposit: zeros(n), release: zeros(n), balance: ramp.slice(), initialFund: ca.rampUpReserveAmount };
  for(let i=0;i<n;i++){
    const prev = i===0 ? ca.rampUpReserveAmount : ramp[i-1];
    rampMov.release[i] = Math.max(0, prev - ramp[i]);
  }

  // Total initial funding (from proceeds at SC) for Sources & Uses
  const totalInitialReserveFunding =
    (dsraMode === 'initial' ? dsraTotalInitial : 0) +
    (omMode === 'initial' ? omMov.initialFund : 0) +
    ca.rampUpReserveAmount;

  return {
    dsraTarget: dsra, omTarget: om, rampUp: ramp, mmr,
    dsraTargetLevel,
    dsra: dsraMov, dsraByInst, om: omMov, mmrAcct: mmrMov, rampAcct: rampMov,
    dsraMode, omMode, mmrMode:'deposits',
    mmEvents, mmEventCost,
    totalInitialReserveFunding,
  };
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
function buildFullModel(rawModel){
  // Defensive merge: ensure all required top-level keys exist by merging over a fresh default.
  // Guards against stale localStorage states missing any field.
  const DM = defaultModel();  // defaultModel is a factory function
  const model = {...DM};
  if(rawModel && typeof rawModel === 'object'){
    for(const k of Object.keys(rawModel)){
      // use the saved value only if it's non-null; otherwise keep default
      if(rawModel[k] != null) model[k] = rawModel[k];
    }
  }
  // Belt-and-suspenders: guarantee every default key is present
  for(const k of Object.keys(DM)){
    if(model[k] == null) model[k] = DM[k];
  }
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
  const tifiaInst = model.tifia?.instrumentId
    ? instruments.find(i=>i.id===model.tifia.instrumentId && i.type==='TIFIA Loan')
    : instruments.find(i=>i.type==='TIFIA Loan');  // fallback for old saves without instrumentId

  // --- CONSTRUCTION DRAWS: sequential by drawdownPriority (cheapest/lowest number first) ---
  // Grants → RAN → PABs → TIFIA → Equity. Exhausts each source before drawing the next.
  // This minimises IDC, maximises equity IRR, and matches standard PF practice.
  const drawsByInst = {};
  instruments.forEach(i => { drawsByInst[i.id] = zeros(cm); });
  const tifiaMonthlyDraws = zeros(cm);
  const nonTifiaDebtDraws = zeros(cm);

  const instRemaining = {};
  instruments.forEach(i => { if(i.seniority !== 'Paygo') instRemaining[i.id] = i.amount; });
  const sortedInsts = [...instruments.filter(i => i.seniority !== 'Paygo')]
    .sort((a,b) => (a.drawdownPriority||99) - (b.drawdownPriority||99));
  const paygoMonthly = paygoSched.monthly || zeros(cm);

  for(let m=0; m<cm; m++){
    const pgM = paygoMonthly[m] || 0;
    instruments.forEach(i => { if(i.seniority === 'Paygo') drawsByInst[i.id][m] = pgM; });
    let remaining = Math.max(0, capexSched.monthly[m] - pgM);
    for(const inst of sortedInsts){
      if(remaining <= 0) break;
      const avail = instRemaining[inst.id] || 0;
      if(avail <= 0) continue;
      const draw = Math.min(remaining, avail);
      drawsByInst[inst.id][m] += draw;
      instRemaining[inst.id] -= draw;
      remaining -= draw;
      if(tifiaInst && inst.id === tifiaInst.id) tifiaMonthlyDraws[m] = draw;
      else if(!['Grant','Equity','Paygo'].includes(inst.seniority)) nonTifiaDebtDraws[m] += draw;
    }
  }

  const tifiaConstr = tifiaInst
    ? {...buildTIFIAConstructionInterest(tifiaInst, tifiaMonthlyDraws, model.tifia, model), monthlyDraws: tifiaMonthlyDraws}
    : { monthlyInterest: zeros(cm), monthlyBalance: zeros(cm), monthlyDraws: zeros(cm), capitalizations: [], capitalizedInterestTotal: 0, finalBalance: 0 };

  // ── Per-instrument IDC: escrow model for public bonds, sequential for bank debt ──
  // Public bonds (escrowRate > 0): issued at FC in full, undrawn proceeds earn escrowRate
  //   Gross IDC = full_amount × coupon from day 1
  //   Escrow earnings = undrawn_balance × escrowRate
  //   Net IDC = Gross − Escrow
  // Bank debt (escrowRate = 0): IDC = drawn_balance × rate (sequential model)
  let ntIDC = 0;
  const ntIDCMonthly = zeros(cm);
  const idcByInst = {};  // { instId: { gross, escrow, net, monthly } }
  let ntBal = 0;  // for blended fallback on non-escrow instruments

  instruments.forEach(inst => {
    if(inst.id === (tifiaInst?.id)) return;  // TIFIA handled separately
    if(['Grant','Equity','Paygo'].includes(inst.seniority)) return;
    const escrowRate = inst.escrowRate || 0;
    const couponRate = inst.rate || 0;
    const fullAmt = inst.amount || 0;
    if(escrowRate > 0 && fullAmt > 0){
      // Escrow model: gross IDC from day 1 on full face, net of escrow earnings on undrawn
      let cumDrawn = 0, gross = 0, escrow = 0;
      const monthly = zeros(cm);
      for(let m=0; m<cm; m++){
        const g = fullAmt * couponRate / 12;
        const undrawn = Math.max(0, fullAmt - cumDrawn);
        const e = undrawn * escrowRate / 12;
        const net = g - e;
        monthly[m] = net;
        gross += g; escrow += e; ntIDC += net; ntIDCMonthly[m] += net;
        cumDrawn += drawsByInst[inst.id]?.[m] || 0;
        cumDrawn = Math.min(cumDrawn, fullAmt);
      }
      idcByInst[inst.id] = { gross, escrow, net: gross - escrow, monthly };
    } else if(couponRate > 0){
      // Sequential model: IDC on drawn balance only
      let bal = 0, net = 0;
      const monthly = zeros(cm);
      for(let m=0; m<cm; m++){
        const i = bal * (couponRate / 12);
        monthly[m] = i; net += i; ntIDC += i; ntIDCMonthly[m] += i;
        bal += drawsByInst[inst.id]?.[m] || 0;
      }
      idcByInst[inst.id] = { gross: net, escrow: 0, net, monthly };
    }
  });
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
    // No issuance cost if the instrument isn't actually issued (amount = 0, e.g. TIFIA off)
    const escalated = (base > 0 && (inst.amount || 0) > 0) ? base * Math.pow(1 + esc, yearsToFC) : 0;
    issuanceCostsByID[inst.id] = escalated;
    totalIssuanceCost += escalated;
  }
  const totalUses = capexSched.totalNominal + ntIDC + tifiaConstr.capitalizedInterestTotal + financingFees + totalIssuanceCost;

  const periods = generateOperatingPeriods(model);
  const n = periods.length;
  const revSched = buildRevenueSchedule(model, periods);
  const opexSched = buildOpexSchedule(model, periods, revSched);
  // Availability payment stream (AP mode): government pays a level, escalating amount each period.
  // apAmount is the per-period base; solved by the cascade (stored on model.financing.apAmount).
  const apMode = model.general.governmentSupportMode === 'ap';
  const apEsc = model.general.apEscalation || 0;
  const apBasePerPeriod = apMode ? (model.financing.apAmount || 0) : 0;
  const apStream = zeros(n);
  if(apMode && apBasePerPeriod > 0){
    for(let i=0;i<n;i++){
      const yr = Math.floor(i / ppy);
      apStream[i] = apBasePerPeriod * Math.pow(1 + apEsc, yr);
    }
  }
  const cfads = zeros(n);
  for(let i=0;i<n;i++) cfads[i] = revSched.byPeriod[i] + apStream[i] - opexSched.byPeriod[i];

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
  if(tifiaInst && (tifiaInst.amount || 0) > 0){  // only charge fees if TIFIA actually drawn
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
  const controlAccts = buildControlAccounts(model, periods, totalDS, opexSched.byPeriod, debtSchedules, instruments);
  // Net reserve movement per period (deposits are outflows, releases inflows)
  // Only reserves in 'deposits' mode affect operating cash; 'initial' mode is funded from proceeds at SC.
  const reserveNetDeposit = zeros(n);
  for(let i=0;i<n;i++){
    let net = 0;
    if(controlAccts.dsraMode === 'deposits') net += (controlAccts.dsra.deposit[i]||0) - (controlAccts.dsra.release[i]||0);
    if(controlAccts.omMode === 'deposits') net += (controlAccts.om.deposit[i]||0) - (controlAccts.om.release[i]||0);
    // MMR: deposit (smoothed) + actual MM event cost − release (reserve covers cost).
    // Net cash = deposit, since eventCost ≈ release. Cost no longer in opex/CFADS.
    net += (controlAccts.mmrAcct.deposit[i]||0) + (controlAccts.mmEventCost?.[i]||0) - (controlAccts.mmrAcct.release[i]||0);
    // Ramp-up reserve releases always add back to cash
    net -= (controlAccts.rampAcct.release[i]||0);
    reserveNetDeposit[i] = net;
  }
  // Raw equity CF before lockup trapping (after reserve movements)
  const rawEquityCF = zeros(n);
  for(let i=0;i<n;i++){
    let base;
    if(model.waterfall.mode === 'Debt-first (Revenue → DS → Opex)'){
      base = revSched.byPeriod[i] - totalDS[i] - opexSched.byPeriod[i] - tifiaFeesPerPeriod[i];
    } else {
      base = cfadsForDscr[i] - totalDS[i];
    }
    rawEquityCF[i] = base - reserveNetDeposit[i];  // reserves sit above equity in waterfall
  }
  // Initial-funded reserves are a Use of funds at SC (drawn from proceeds)
  const initialReserveFunding = controlAccts.totalInitialReserveFunding || 0;
  const totalUsesWithReserves = totalUses + initialReserveFunding;
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
    periods, capexSched, paygoSched, tifiaConstr, drawsByInst,
    nonTIFIAIDC: ntIDC, nonTIFIAIDCMonthly: ntIDCMonthly, idcByInst, financingFees,
    capitalizedTIFIAInterest: tifiaConstr.capitalizedInterestTotal,
    totalUses, totalSources: sourcesTotal, grantTotal, equityTotal, paygoTotal, debtTotal,
    totalIssuanceCost, issuanceCostsByID,
    tifiaAdminPerPeriod, tifiaMonitoringPerPeriod, tifiaFeesPerPeriod, totalTifiaFees,
    cfadsForDscr,
    revSched, opexSched, cfadsByPeriod: cfads, apStream, apMode, apBasePerPeriod,
    instruments: sortedInst, debtSchedules,
    seniorDS, subDS, shortDS, totalDS,
    seniorBal, subBal, seniorInt, seniorPri, subInt, subPri,
    seniorDSCR, totalDSCR, llcrSenior, llcrTotal, plcrSenior,
    walByInstrument, overallObligation, overallPasses,
    lockup, lockupAcct, rawEquityCF, controlAccts, reserveNetDeposit,
    initialReserveFunding, totalUsesWithReserves,
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
// ── AVAILABILITY-PAYMENT CASCADE ──
// AP mode: contractual payment stream removes the CFADS coverage cap on debt.
// 1) TIFIA → full 49% of eligible capex
// 2) PABs → fill until total debt = target gearing × total uses
// 3) Equity → fill remainder to target IRR
// 4) AP (level, escalating) solved so equity hits target IRR
function autoCascadeAP(model, params){
  const working = JSON.parse(JSON.stringify(model));
  const trace = [];
  const tifiaEnabled = params.tifiaEnabled !== false;
  const maxTifiaPct = params.maxTifiaPct || 0.49;
  const targetGearing = model.general.targetGearing || 0.75;
  const targetIRR = params.targetEquityIRR || 0.12;

  // Build with a candidate AP base; size debt by gearing, equity as plug, return equity IRR
  const evaluate = (apBase) => {
    const w = JSON.parse(JSON.stringify(working));
    w.financing.apAmount = apBase;
    // STEP 1: TIFIA at full 49% of eligible capex
    let tempR;
    try { tempR = buildFullModel(w); } catch(e){ return {error:e.message}; }
    let eligibleCost = 0;
    for(const id of (params.tifiaEligibleCapexIds||[])) eligibleCost += sum(tempR.capexSched.byItem[id]||[]);
    const tifia = w.financing.instruments.find(i=>i.id===params.tifiaInstrumentId);
    if(tifia){
      tifia.amount = tifiaEnabled ? Math.round(eligibleCost * maxTifiaPct) : 0;
      if(tifiaEnabled){
        // Build standard TIFIA phases
        const phRes = buildTifiaCascadePhases(w, params.tifiaInstrumentId, {
          deferYears: params.deferYears, ioYears: params.ioYears,
          testYearsBeforeMaturity: params.testYearsBeforeMaturity, phase3Mode: params.phase3Mode,
        }, tempR.cfadsForDscr || tempR.cfadsByPeriod);
        if(!phRes.error){ tifia.phases = phRes.phases; tifia.repaymentStyle = 'Phased (multi-regime)'; }
      }
    }
    // STEP 2: PAB sized so total debt = gearing × total uses
    let rB;
    try { rB = buildFullModel(w); } catch(e){ return {error:e.message}; }
    const totalUses = rB.totalUsesWithReserves || rB.totalUses;
    const targetDebt = targetGearing * totalUses;
    const tifiaAmt = tifia ? tifia.amount : 0;
    const pabInst = w.financing.instruments.find(i=>i.id===params.pabInstrumentId);
    if(pabInst){
      pabInst.amount = Math.max(0, Math.round(targetDebt - tifiaAmt));
    }
    // STEP 3: Equity as plug to balance; then measure IRR
    let rC;
    try { rC = buildFullModel(w); } catch(e){ return {error:e.message}; }
    const eqInst = w.financing.instruments.find(i=>i.id===params.equityInstrumentId);
    const gap = rC.totalUsesWithReserves - rC.totalSources;  // remaining funded by equity
    if(eqInst){ eqInst.amount = Math.max(0, (eqInst.amount||0) + gap); }
    let rD;
    try { rD = buildFullModel(w); } catch(e){ return {error:e.message}; }
    // Min total DSCR over debt-service periods
    let minDSCR = Infinity;
    for(let i=0;i<rD.periods.length;i++){
      const td = (rD.seniorDS[i]||0) + (rD.subDS?.[i]||0);
      if(td > 1000){
        const cfi = rD.cfadsForDscr?.[i] ?? rD.cfadsByPeriod[i] ?? 0;
        const d = cfi / td;
        if(d < minDSCR) minDSCR = d;
      }
    }
    if(!isFinite(minDSCR)) minDSCR = null;
    return { w, irr: rD.equityIRR, minDSCR, result: rD, tifiaAmt, pabAmt: pabInst?pabInst.amount:0, eqAmt: eqInst?eqInst.amount:0, totalUses };
  };

  const minDSCRFloor = params.minTotalDSCR || 1.10;

  // Solve 1: AP that hits target equity IRR
  const solveFor = (testFn) => {
    let lo = 0, hi = 300_000_000, found = null;
    for(let iter=0; iter<44; iter++){
      const mid = (lo+hi)/2;
      const ev = evaluate(mid);
      if(ev.error){ hi = mid; continue; }
      found = ev;
      const {ok, raise} = testFn(ev);
      if(ok) break;
      if(raise) lo = mid; else hi = mid;
    }
    return found;
  };

  // AP for IRR target
  const evIRR = solveFor(ev => {
    const irr = ev.irr || 0;
    return { ok: Math.abs(irr - targetIRR) < 0.0001, raise: irr < targetIRR };
  });
  const apForIRR = evIRR ? evIRR.w.financing.apAmount : 0;

  // AP for DSCR floor
  const evDSCR = solveFor(ev => {
    const d = ev.minDSCR ?? 99;
    return { ok: Math.abs(d - minDSCRFloor) < 0.002, raise: d < minDSCRFloor };
  });
  const apForDSCR = evDSCR ? evDSCR.w.financing.apAmount : 0;

  // Final AP = max of the two constraints (whichever binds)
  const apFinal = Math.max(apForIRR, apForDSCR);
  const binding = apForDSCR > apForIRR ? 'DSCR floor' : 'Equity IRR';
  const best = evaluate(apFinal);
  if(best.error) return { error:'AP cascade failed: '+best.error, converged:false };
  best.w.financing.apAmount = apFinal;
  trace.push({apForIRR, apForDSCR, apFinal, binding, irr: best.irr, minDSCR: best.minDSCR,
    tifia: best.tifiaAmt, pab: best.pabAmt, equity: best.eqAmt});

  return {
    converged: true, trace,
    best: {
      apBasePerPeriod: apFinal,
      apEscalation: model.general.apEscalation||0,
      apBinding: binding,
      tifiaAmount: best.tifiaAmt, pabAmount: best.pabAmt, equityAmount: best.eqAmt,
      actualEquityIRR: best.irr, minDSCR: best.minDSCR, targetGearing,
      upfrontSubsidy: 0,
      workingModel: best.w,
      pct: best.tifiaAmt && best.totalUses ? best.tifiaAmt / best.totalUses : 0,
    },
  };
}

function autoCascadeTifia(model, params){
  const working = JSON.parse(JSON.stringify(model));
  const trace = [];

  const evaluate = (pct) => {
    const w = JSON.parse(JSON.stringify(working));
    let tempR;
    try { tempR = buildFullModel(w); }
    catch(e){ return { pct, error:'init build failed: '+e.message, feasible:false }; }

    // STEP 1: SIZE TIFIA (skip if disabled)
    const tifiaEnabled = params.tifiaEnabled !== false;  // default true
    let eligibleCost = 0;
    for(const id of (params.tifiaEligibleCapexIds || [])){
      eligibleCost += sum(tempR.capexSched.byItem[id] || []);
    }
    const tifia = w.financing.instruments.find(i => i.id === params.tifiaInstrumentId);
    let tifiaAmount = 0;
    if(!tifia) return { pct, error:'TIFIA instrument not found', feasible:false };
    if(tifiaEnabled){
      tifiaAmount = Math.round(eligibleCost * pct);
      tifia.amount = tifiaAmount;
    } else {
      tifia.amount = 0;  // TIFIA off — zero it out regardless of pct
      tifiaAmount = 0;
    }

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
    // PABs size when: TIFIA disabled, OR TIFIA hit statutory ceiling AND gap remains
    let pabAmount = 0;
    const maxTifiaPct = params.maxTifiaPct || 0.49;
    const tifiaAtCeiling = tifiaEnabled && (pct >= maxTifiaPct - 0.005);
    const shouldSizePab = !tifiaEnabled || tifiaAtCeiling;
    if(pabInst){
      if(!shouldSizePab){
        // TIFIA stopped below ceiling — adding PAB would hurt Total DSCR
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

    // STEP 3: SIZE EQUITY TO TARGET IRR (plug = Upfront Subsidy, kept closed in every iteration)
    let equityAmount = null, equityForIRRCalc = null, upfrontSubsidy = 0;
    const targetIRR = params.targetEquityIRR || 0;
    const plugInst = params.plugInstrumentId
      ? w.financing.instruments.find(i => i.id === params.plugInstrumentId) : null;
    const equityInst = params.equityInstrumentId
      ? w.financing.instruments.find(i => i.id === params.equityInstrumentId) : null;

    if(equityInst && targetIRR > 0){
      // max_equity = gap when equity=0 AND plug=0
      if(plugInst) plugInst.amount = 0;
      equityInst.amount = 0;
      let baseR;
      try { baseR = buildFullModel(w); } catch(e){ baseR = null; }
      if(baseR){
        const maxEquity = Math.max(0, baseR.totalUses - baseR.totalSources);
        let loEq = 0, hiEq = maxEquity;
        equityAmount = 0;
        for(let k=0; k<30; k++){
          const mid = (loEq + hiEq) / 2;
          equityInst.amount = Math.round(mid);
          if(plugInst) plugInst.amount = Math.max(0, Math.round(maxEquity - mid));
          let actualIRR = -1;
          try {
            const testR = buildFullModel(w);
            actualIRR = (testR.equityIRR != null) ? testR.equityIRR : -1;
          } catch(e){}
          if(actualIRR >= targetIRR - 0.0001){
            equityAmount = mid;
            loEq = mid;
          } else {
            hiEq = mid;
          }
          if(hiEq - loEq < 10_000) break;
        }
        equityInst.amount = Math.round(equityAmount);
        if(plugInst){
          plugInst.amount = Math.max(0, Math.round(maxEquity - equityAmount));
          upfrontSubsidy = plugInst.amount;
        }
        equityForIRRCalc = equityAmount;
      }
    }

    // STEP 4: FINAL BUILD + UPFRONT SUBSIDY (plug already set in Step 3; verify)
    let finalR;
    try { finalR = buildFullModel(w); }
    catch(e){ return { pct, tifiaAmount, error:'final build failed: '+e.message, feasible:false }; }
    let plugApplied = 0;
    if(plugInst){
      const gap = finalR.totalUses - finalR.totalSources;
      if(Math.abs(gap) > 100){
        plugInst.amount = Math.max(0, Math.round(plugInst.amount + gap));
        plugApplied = gap;
        try { finalR = buildFullModel(w); } catch(e){}
      }
      upfrontSubsidy = plugInst.amount;
    } else if(params.plugInstrumentId) {
      // plug instrument missing (old saved state without sub1) — fall back to first grant
      const fallbackGrant = w.financing.instruments.find(i => i.seniority === 'Grant');
      if(fallbackGrant){
        const gap = finalR.totalUses - finalR.totalSources;
        fallbackGrant.amount = Math.max(0, Math.round((fallbackGrant.amount||0) + gap));
        upfrontSubsidy = fallbackGrant.amount;
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
    // When TIFIA disabled: 50% test vacuously passes, no TIFIA eff DSCR floor
    const testPassed = !tifiaEnabled || (testBalAtPoint != null && testBalAtPoint <= 0.5 * tifiaAmount + 1000);
    if(!tifiaEnabled) minTifiaEffDSCR = null;

    const feasible = (
      (minTotalDSCR == null || minTotalDSCR >= (params.minTotalDSCR || 1.10) - 0.005)
      && (minTifiaEffDSCR == null || minTifiaEffDSCR >= (params.minTifiaDSCR || 1.10) - 0.005)
      && (srForFeas >= (params.minSrDSCR || 1.30) - 0.005)
      && testPassed
    );

    return {
      pct, tifiaAmount, pabAmount: Math.round(pabAmount),
      equityAmount: equityAmount ? Math.round(equityAmount) : 0,
      equityForIRRCalc: equityForIRRCalc ? Math.round(equityForIRRCalc) : 0,
      upfrontSubsidy: Math.round(upfrontSubsidy),
      actualEquityIRR: finalR.equityIRR,
      targetEquityIRR: targetIRR,
      eligibleCost,
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
  const v = model.vfm || defaultModel().vfm;
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

  // ── LEVERAGED PSC ──
  // Public delivery is also debt-financed to the project's capacity (same CFADS supports same debt).
  // Public funds only the residual gap (capex − debt raised) at FC; services debt over time from toll revenue.
  // PSC cost = capex + opex + risk + mitigation + comp-neutrality − revenue, where capex is split into
  //            (debt-funded, repaid via debt service) + (gap-funded by public upfront).
  // Since debt service ≈ the financed capex grossed up by interest, the leverage effect on a public-sector
  // discount-rate basis is: replace the lump-sum financed capex with its debt-service NPV (interest cost on public books).
  const totalDebtRaised = (results.debtTotal || 0);  // TIFIA + PABs + other debt the optimizer sized
  const nominalCapex = (results.capexSched?.totalNominal || 0);
  // Fraction of capex covered by debt (capped at 100%)
  const debtCoverFrac = nominalCapex > 0 ? Math.min(1, totalDebtRaised / nominalCapex) : 0;
  // Debt service NPV (public services the debt from revenue) — use the model's actual debt schedules
  let pscDebtServiceNPV = 0;
  if(results.periods && results.seniorInt){
    for(let i = 0; i < results.periods.length; i++){
      const ds = (results.seniorInt[i]||0) + (results.seniorPri[i]||0) + (results.subInt?.[i]||0) + (results.subPri?.[i]||0);
      // discount at PSC rate from financial close
      const t = constYrs + (i / (model.general.periodsPerYear||2));
      pscDebtServiceNPV += ds / Math.pow(1 + rate, t);
    }
  }
  // Public upfront gap = capex premium-adjusted NPV that debt does NOT cover
  const pscCapexGapNPV = pscCapexNPV * (1 - debtCoverFrac);
  // Leveraged capex cost on public books = upfront gap + NPV of debt service
  const pscLeveragedCapexNPV = pscCapexGapNPV + pscDebtServiceNPV;

  const pscUseLeverage = v.pscUseLeverage !== false;  // default ON
  const pscCapexComponent = pscUseLeverage ? pscLeveragedCapexNPV : pscCapexNPV;

  const pscNetCost = pscCapexComponent + pscOpexNPV + pscConstrRiskNPV + pscOpsRiskNPV
                     + totalConstrMitNPV + totalOpsMitNPV
                     + compNeutralityAdj - pscRevenueNPV;

  // P3 from public perspective: public-share residual risk + public-share mitigation cost
  const p3PublicConstrRiskNPV = publicConstrEV / Math.pow(1 + rate, constYrs / 2);
  const p3PublicOpsRiskNPV    = npvAnnuity(annualPublicOpsEV, opsYrs, rate, constYrs);

  // ── Government support from the actual optimizer result (fully integrated) ──
  const lastRun = model.optimizer?.lastAutoCascadeRun;
  const optimizerRun = !!(lastRun && lastRun.converged);
  const apModeActive = model.general.governmentSupportMode === 'ap';
  const solvedSubsidy = lastRun?.bestSubsidy || 0;         // upfront subsidy (already a value at FC)
  const solvedAPBase  = lastRun?.bestAP || 0;              // solved AP base per period
  const apEscRate     = model.general.apEscalation || 0;
  const ppySched      = model.general.periodsPerYear || 2;

  let p3NetCost, p3Components, p3GovSupportNPV = 0, p3SupportLabel = '';

  if(apModeActive){
    // P3 cost = NPV of the SOLVED availability-payment stream (escalating), from start of ops
    let apNPV = 0;
    const apBaseAnnual = solvedAPBase * ppySched;  // per-period × periods/yr = annual
    for(let y = 0; y < opsYrs; y++){
      const ap = apBaseAnnual * Math.pow(1 + apEscRate, y);
      apNPV += ap / Math.pow(1 + rate, constYrs + y + 0.5);
    }
    p3GovSupportNPV = apNPV;
    p3SupportLabel = 'Solved Availability Payments (NPV)';
    p3NetCost = apNPV + p3PublicConstrRiskNPV + p3PublicOpsRiskNPV + publicConstrMitNPV + publicOpsMitNPV;
    p3Components = { govSupportNPV: apNPV, supportLabel: p3SupportLabel,
                     p3PublicConstrRiskNPV, p3PublicOpsRiskNPV, publicConstrMitNPV, publicOpsMitNPV };
  } else {
    // Toll concession: government's cost = solved upfront subsidy − upfront concession fee
    const upfrontFee = v.upfrontConcessionFee || 0;
    // Subsidy is paid at financial close (end of construction); discount to t0
    const subsidyNPV = solvedSubsidy / Math.pow(1 + rate, constYrs);
    p3GovSupportNPV = subsidyNPV;
    p3SupportLabel = 'Solved Upfront Subsidy (NPV)';
    p3NetCost = subsidyNPV + p3PublicConstrRiskNPV + p3PublicOpsRiskNPV
                + publicConstrMitNPV + publicOpsMitNPV - upfrontFee;
    p3Components = { govSupportNPV: subsidyNPV, supportLabel: p3SupportLabel,
                     upfrontFee,
                     p3PublicConstrRiskNPV, p3PublicOpsRiskNPV, publicConstrMitNPV, publicOpsMitNPV };
  }

  const vfmAbs = pscNetCost - p3NetCost;
  const vfmPct = pscNetCost !== 0 ? vfmAbs / Math.abs(pscNetCost) : 0;

  // Sensitivity grid (uses post-mit EVs as base; scales with riskMult)
  const sensitivityGrid = [];
  for(const dr of [0.030, 0.040, 0.045, 0.050, 0.060, 0.070]){
    const row = { discountRate: dr, cells: [] };
    for(const riskMult of [0.5, 0.75, 1.0, 1.25, 1.5]){
      const psc = (pscCapexComponent + pscOpexNPV) * (rate / dr)
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
      if(apModeActive){
        let apNPV = 0;
        const apBaseAnnual = solvedAPBase * ppySched;
        for(let y = 0; y < opsYrs; y++){
          apNPV += (apBaseAnnual * Math.pow(1 + apEscRate, y)) / Math.pow(1 + dr, constYrs + y + 0.5);
        }
        p3 += apNPV;
      } else {
        // Solved subsidy − concession fee (no foregone revenue)
        p3 += (solvedSubsidy / Math.pow(1 + dr, constYrs)) - (v.upfrontConcessionFee || 0);
      }
      row.cells.push({ riskMult, psc, p3, vfm: psc - p3 });
    }
    sensitivityGrid.push(row);
  }

  return {
    pscDiscountRate: rate,
    pscCapexNPV, pscOpexNPV, pscConstrRiskNPV, pscOpsRiskNPV,
    pscUseLeverage, pscDebtServiceNPV, pscCapexGapNPV, pscLeveragedCapexNPV,
    pscCapexComponent, totalDebtRaised, debtCoverFrac,
    pscRevenueNPV, compNeutralityAdj, pscNetCost,
    pscMitConstrNPV: totalConstrMitNPV, pscMitOpsNPV: totalOpsMitNPV,
    p3NetCost, p3Components, isAvailabilityBased: apModeActive,
    optimizerRun, apModeActive, solvedSubsidy, solvedAPBase, p3GovSupportNPV, p3SupportLabel,
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
    <Section title="Government Support Mode" subtitle="How the public sector closes the viability gap.">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Support Mechanism" hint="Upfront Subsidy = capital grant at FC, debt capped by CFADS coverage. Availability Payment = contractual annual stream, debt sized by gearing, TIFIA to full 49%.">
          <Select value={g.governmentSupportMode==='ap'?'Availability Payment':'Upfront Subsidy'}
            onChange={v=>setG('governmentSupportMode', v==='Availability Payment'?'ap':'subsidy')}
            options={['Upfront Subsidy','Availability Payment']}/>
        </Field>
        {g.governmentSupportMode==='ap' && (
          <Field label="AP Escalation (%/yr)" hint="Annual escalation of the availability payment stream">
            <NumInput value={g.apEscalation||0} onChange={v=>setG('apEscalation',v)} step={0.005} suffix="%"/>
          </Field>
        )}
      </div>
      {g.governmentSupportMode==='ap' && (
        <div className="mt-3 bg-amber-500/5 border border-amber-500/30 rounded p-3 text-xs text-amber-200">
          AP mode: the contractual payment stream removes the CFADS coverage cap on debt. TIFIA sizes to its full 49% statutory limit, PABs fill to the target gearing ratio (set in the Financing tab), equity fills the remainder to target IRR, and the optimizer solves the AP amount. No upfront subsidy.
        </div>
      )}
    </Section>
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
    <Section title="Government Support Mode" subtitle="Upfront subsidy (capital grant at FC) vs availability payments (contractual stream over operations).">
      <div className="grid grid-cols-3 gap-4">
        <Field label="Support Mechanism" hint="AP mode: contractual payments remove the CFADS coverage cap — TIFIA can reach full 49%, PABs fill to target gearing, equity to target IRR.">
          <Select value={g.governmentSupportMode==='ap'?'Availability Payment':'Upfront Subsidy'}
            onChange={v=>setG('governmentSupportMode', v==='Availability Payment'?'ap':'subsidy')}
            options={['Upfront Subsidy','Availability Payment']}/>
        </Field>
        {g.governmentSupportMode==='ap' && (
          <Field label="AP Escalation (%/yr)" hint="Annual escalation of the availability payment stream"><NumInput value={g.apEscalation} onChange={v=>setG('apEscalation',v)} step={0.005} suffix="%"/></Field>
        )}
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
    {model.general.governmentSupportMode === 'ap' && (
      <Section title="Availability Payment Structure" subtitle="AP mode active — government support is a contractual payment stream, not an upfront grant. Debt is sized by gearing, not CFADS coverage.">
        <div className="grid grid-cols-3 gap-4">
          <Field label="Target Gearing (% of total uses)" hint="Max total debt (TIFIA + PABs) as a share of total uses. PABs fill from TIFIA's 49% up to this level.">
            <NumInput value={model.general.targetGearing} onChange={v=>setModel({...model, general:{...model.general, targetGearing:v}})} step={0.05} suffix="%"/>
          </Field>
          <Field label="AP Escalation (%/yr)"><NumInput value={model.general.apEscalation} onChange={v=>setModel({...model, general:{...model.general, apEscalation:v}})} step={0.005} suffix="%"/></Field>
        </div>
        <p className="text-xs text-stone-500 mt-3">The Optimizer sizes TIFIA to full 49%, PABs to hit target gearing, equity to target IRR, and solves the AP stream so equity IRR and the minimum DSCR floor are both met (AP = max of the two binding constraints).</p>
      </Section>
    )}
    <Section title="Construction-Period Financing Parameters">
      <div className="grid grid-cols-3 gap-4">
        <Field label="Blended IDC Rate — non-TIFIA debt"><NumInput value={f.blendedIDCRateForNonTIFIA} onChange={v=>setF({blendedIDCRateForNonTIFIA:v})} step={0.005} suffix="%"/></Field>
        <Field label="Financing Fees (% of total debt)"><NumInput value={f.financingFeesPctOfDebt} onChange={v=>setF({financingFeesPctOfDebt:v})} step={0.005} suffix="%"/></Field>
        <Field label="Issuance Cost Base Year" hint="Per-instrument issuance costs escalated from this year to FC year"><NumInput value={f.issuanceCostBaseYear} onChange={v=>setF({issuanceCostBaseYear:v})}/></Field>
      </div>
      <p className="text-xs text-stone-500 mt-3">TIFIA construction interest is computed separately (act/act day-count, semi-annual cap). See TIFIA tab. Issuance costs are set per instrument below and added to Uses.</p>
    </Section>
    <Section title="Capital Stack" subtitle="TIFIA and Equity are configured in the Optimizer tab. Upfront Subsidy (sub1) is set by the Optimizer."
      action={<button onClick={addInst} className="text-xs px-3 py-1.5 bg-amber-500/10 border border-amber-500/50 text-amber-300 rounded hover:bg-amber-500/20">+ Add Instrument</button>}>
      <div className="space-y-3">{f.instruments.filter(inst =>
        inst.type !== 'TIFIA Loan' &&
        inst.seniority !== 'Equity' &&
        inst.id !== 'sub1'
      ).map(inst=>{
        const isGrant = inst.seniority === 'Grant';
        const isGANBAN = inst.repaymentStyle === 'Anticipation Note (GAN/BAN)';
        if(isGrant && !isGANBAN) return (
          // Simplified grant row — no rate/tenor/repayment/issuance fields
          <div key={inst.id} className="bg-stone-900/40 border border-emerald-800/40 rounded p-3">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-sm font-medium text-emerald-300">{inst.type}</span>
              <span className="text-[10px] font-mono text-stone-500 bg-stone-800 px-1.5 py-0.5 rounded">{inst.id}</span>
              <span className="ml-auto text-[10px] text-emerald-500 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded">Grant — no repayment · no rate · no issuance</span>
              <button onClick={()=>removeInst(inst.id)} className="text-stone-600 hover:text-rose-400 text-xs px-2">✕</button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Grant Amount ($)"><NumInput value={inst.amount} onChange={v=>updateInst(inst.id,{amount:v})} prefix="$"/></Field>
              <Field label="Expected Date" hint="When grant funds arrive at FC"><TextInput value={inst.closeDate} onChange={v=>updateInst(inst.id,{closeDate:v})}/></Field>
              <Field label="Draw Priority" hint="Lower = drawn earlier in construction waterfall"><NumInput value={inst.drawdownPriority} onChange={v=>updateInst(inst.id,{drawdownPriority:v})}/></Field>
            </div>
            <div className="mt-2">
              <Field label="Covenants / Grant Conditions"><TextInput value={inst.covenants} onChange={v=>updateInst(inst.id,{covenants:v})}/></Field>
            </div>
            <div className="text-[10px] text-stone-500 mt-2">
              Grant is drawn proportionally into the construction waterfall by priority. Not a debt instrument — no DSCR impact, no repayment obligations.
              To model a Grant/Bond Anticipation Note against this grant, add a new instrument with style "Anticipation Note (GAN/BAN)".
            </div>
          </div>
        );
        return (
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
            {/* Style-dependent fields */}
            {(inst.repaymentStyle === 'Sculpted (target DSCR)' || inst.repaymentStyle === 'Deferred P&I then sculpted') &&
              <Field label="Target DSCR" hint="Sculpting target"><NumInput value={inst.targetDSCR} onChange={v=>updateInst(inst.id,{targetDSCR:v})} step={0.05}/></Field>}
            {(inst.repaymentStyle === 'IO then amortize' || inst.repaymentStyle === 'Level debt service' || inst.repaymentStyle === 'Equal principal') &&
              <Field label="IO Years" hint="Pay interest only for this many years before amortization starts"><NumInput value={inst.ioYears} onChange={v=>updateInst(inst.id,{ioYears:v})}/></Field>}
            {inst.repaymentStyle !== 'Phased (multi-regime)' && inst.repaymentStyle !== 'Bullet' && inst.repaymentStyle !== 'Custom schedule' &&
              <Field label="Deferral Years" hint="Defer all payments (P&I) for this many years"><NumInput value={inst.deferralYears} onChange={v=>updateInst(inst.id,{deferralYears:v})}/></Field>}
          </div>
            {inst.repaymentStyle === 'Anticipation Note (GAN/BAN)' && (
              <div className="col-span-4 bg-amber-500/5 border border-amber-500/30 rounded p-3 mt-1">
                <div className="text-[10px] uppercase tracking-wider text-amber-400 mb-2">GAN/BAN Configuration</div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Anticipated Grant/Bond Amount ($)" hint="The future grant or bond that will retire this note at maturity. Principal is back-calculated as PV of this amount.">
                    <NumInput value={inst.anticipatedAmount||inst.amount} onChange={v=>updateInst(inst.id,{anticipatedAmount:v})} prefix="$"/>
                  </Field>
                  <div className="text-xs text-stone-400 flex items-end pb-2">
                    Computed principal (PV) ≈ {inst.rate>0 ? `$${((inst.anticipatedAmount||inst.amount)/Math.pow(1+inst.rate/(model.general.periodsPerYear||2), Math.round((inst.tenorYears||0)*(model.general.periodsPerYear||2)))/1e6).toFixed(2)}M` : 'set rate + tenor'}
                    . Balance grows via CapI to exactly {inst.anticipatedAmount ? `$${((inst.anticipatedAmount||0)/1e6).toFixed(2)}M` : 'anticipated amount'} at maturity — retired by arriving grant/bond.
                  </div>
                </div>
              </div>
            )}
            {!isGrant && (
              <div className="grid grid-cols-2 gap-4 mt-3">
                <Field label="Issuance Cost ($, base year)" hint={`Base yr: ${f.issuanceCostBaseYear||2024}. Escalated to FC.`}><NumInput value={inst.issuanceCost} onChange={v=>updateInst(inst.id,{issuanceCost:v})} prefix="$"/></Field>
                <Field label="Issuance Cost Escalation (%/yr)"><NumInput value={inst.issuanceCostEscalation} onChange={v=>updateInst(inst.id,{issuanceCostEscalation:v})} step={0.005} suffix="%"/></Field>
                {inst.seniority === 'Senior' && (
                  <Field label="Escrow / Reinvestment Rate" hint="For public bonds issued at FC: undrawn proceeds sit in escrow earning this rate. Net IDC = Gross IDC (coupon on full face) − Escrow earnings. Set 0 for bank debt (no escrow).">
                    <NumInput value={inst.escrowRate||0} onChange={v=>updateInst(inst.id,{escrowRate:v})} step={0.0025} suffix="%"/>
                  </Field>
                )}
              </div>
            )}
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
        </div>);
      })}</div>
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
    <Section title="Equity Distribution Lockup Conditions"
      subtitle="Lockup is triggered when Senior DSCR or LLCR fall below these levels. Lockup excess equity CF gets escrowed in a separate account.">
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
  const updateMMEvent = (i, patch) => setCA({mmEventSchedule: (ca.mmEventSchedule||[]).map((r,idx)=>idx===i?{...r,...patch}:r)});
  return <div>
    <Section title="DSRA — Debt Service Reserve Account">
      <div className="grid grid-cols-3 gap-4">
        <Field label="Funding Mode" hint="Initial = funded at SC from proceeds. Deposits = built from operating cash, reduces distributions.">
          <Select value={ca.dsraFundingMode||'initial'} onChange={v=>setCA({dsraFundingMode:v})} options={['initial','deposits']}/>
        </Field>
        <Field label="Sizing Basis" hint="Max annual DS = look-forward peak. Else uses months-of-DS.">
          <Select value={ca.dsraUseMaxAnnualDS ? 'Max annual DS' : 'Months of DS'} onChange={v=>setCA({dsraUseMaxAnnualDS: v==='Max annual DS'})} options={['Max annual DS','Months of DS']}/>
        </Field>
        <Field label="Months of DS Held" hint="Used when sizing basis = Months of DS"><NumInput value={ca.dsraMonthsDS} onChange={v=>setCA({dsraMonthsDS:v})} suffix="mo"/></Field>
      </div>
    </Section>
    <Section title="O&M Reserve">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Funding Mode"><Select value={ca.omFundingMode||'deposits'} onChange={v=>setCA({omFundingMode:v})} options={['initial','deposits']}/></Field>
        <Field label="Months of Opex Held"><NumInput value={ca.omReserveMonths} onChange={v=>setCA({omReserveMonths:v})} suffix="mo"/></Field>
      </div>
    </Section>
    <Section title="Ramp-up Reserve">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Initial Funding"><NumInput value={ca.rampUpReserveAmount} onChange={v=>setCA({rampUpReserveAmount:v})} prefix="$" step={1000000}/></Field>
        <Field label="Release Over (yrs)"><NumInput value={ca.rampUpReleaseYears} onChange={v=>setCA({rampUpReleaseYears:v})} suffix="yr"/></Field>
      </div>
    </Section>
    <Section title="Major Maintenance Reserve — Event Schedule"
      subtitle="Lumpy MM events are pre-funded by smoothed deposits, then paid from the reserve when due. MM cost is NOT in opex — it flows only through the reserve."
      action={<button onClick={()=>setCA({mmEventSchedule:[...(ca.mmEventSchedule||[]),{id:'mm'+Date.now(),label:'MM',year:10,amount:10_000_000}]})} className="text-xs text-amber-300">+ event</button>}>
      <div className="grid grid-cols-2 gap-4 mb-3">
        <Field label="MM Cost Inflation (%/yr)" hint="Events escalate at this rate from FC to their occurrence year">
          <NumInput value={ca.mmInflation||0} onChange={v=>setCA({mmInflation:v})} step={0.005} suffix="%"/>
        </Field>
      </div>
      <table className="w-full"><thead><tr><TH>Label</TH><TH>Op. Year</TH><TH className="text-right">Base Amount ($)</TH><TH className="text-right">Escalated</TH><TH></TH></tr></thead>
        <tbody>{(ca.mmEventSchedule||[]).map((s,i)=>{
          const esc = s.amount * Math.pow(1+(ca.mmInflation||0), s.year);
          return (<tr key={i}>
            <TD><TextInput value={s.label} onChange={v=>updateMMEvent(i,{label:v})}/></TD>
            <TD><NumInput value={s.year} onChange={v=>updateMMEvent(i,{year:v})} suffix="yr"/></TD>
            <TD className="text-right"><NumInput value={s.amount} onChange={v=>updateMMEvent(i,{amount:v})} prefix="$"/></TD>
            <TD className="text-right text-stone-400">{fmt$(esc)}</TD>
            <TD><button onClick={()=>setCA({mmEventSchedule:(ca.mmEventSchedule||[]).filter((_,idx)=>idx!==i)})} className="text-xs text-rose-400">×</button></TD>
          </tr>);
        })}</tbody></table>
      <div className="text-[10px] text-stone-500 mt-2">Reserve deposits smooth toward each event; at the event year the reserve releases to pay the (escalated) cost. Equity sees only the smooth deposit, not the lumpy payment.</div>
    </Section>
    <Section title="Reserve Account Charts" subtitle="Each reserve shown separately for clarity — balance over time, deposits and releases.">
      {(()=>{
        const ca2 = results.controlAccts || {};
        const labels = results.periods.map(p=>p.label);
        const tick = Math.max(0, Math.floor(results.periods.length/10));
        const mkData = (acct, keys) => results.periods.map((p,i)=>{
          const row = {period:p.label};
          keys.forEach(k => { row[k.name] = Math.round((k.arr[i]||0)/1e5)/10; });
          return row;
        });
        const ChartBox = ({title, children, note}) => (
          <div className="bg-stone-900/30 border border-stone-700/50 rounded-lg p-3 mb-4">
            <div className="text-sm font-medium text-stone-200 mb-1">{title}</div>
            {note && <div className="text-[10px] text-stone-500 mb-2">{note}</div>}
            <div style={{height:200}}><ResponsiveContainer>{children}</ResponsiveContainer></div>
          </div>
        );
        const axisProps = { stroke:"#a8a29e", tick:{fontSize:9} };
        const grid = <CartesianGrid stroke="#44403c" strokeDasharray="2 4"/>;
        const tip = <Tooltip contentStyle={{background:'#1c1917',border:'1px solid #44403c',fontSize:11}} formatter={v=>`$${v}M`}/>;

        // DSRA — per instrument balances
        const dsraInst = ca2.dsraByInst || {};
        const dsraKeys = Object.keys(dsraInst);
        const dsraColors = ['#fbbf24','#fb923c','#f472b6','#60a5fa'];
        const dsraData = results.periods.map((p,i)=>{
          const row = {period:p.label};
          dsraKeys.forEach(id => { row[dsraInst[id].label] = Math.round((dsraInst[id].balance[i]||0)/1e5)/10; });
          return row;
        });

        return <>
          {dsraKeys.length > 0 && (
            <ChartBox title="DSRA — Debt Service Reserve (balance by instrument)" note={`${ca2.dsraMode==='initial'?'Initial-funded at SC':'Funded from operating cash'} · released as each debt matures`}>
              <LineChart data={dsraData}>
                {grid}<XAxis dataKey="period" {...axisProps} interval={tick}/><YAxis {...axisProps} label={{value:'$M',angle:-90,position:'insideLeft',fill:'#a8a29e',fontSize:10}}/>{tip}<Legend wrapperStyle={{fontSize:10}}/>
                {dsraKeys.map((id,idx)=><Line key={id} type="stepAfter" dataKey={dsraInst[id].label} stroke={dsraColors[idx%4]} strokeWidth={2} dot={false}/>)}
              </LineChart>
            </ChartBox>
          )}
          <ChartBox title="Major Maintenance Reserve (deposits build, releases fund events)" note="Sawtooth: balance accumulates via smoothed deposits, drops when an MM event is paid from the reserve.">
            <ComposedChart data={mkData(null,[{name:'Deposit',arr:ca2.mmrAcct?.deposit||[]},{name:'Event Cost',arr:(ca2.mmEventCost||[])},{name:'Balance',arr:ca2.mmrAcct?.balance||[]}])}>
              {grid}<XAxis dataKey="period" {...axisProps} interval={tick}/><YAxis {...axisProps} label={{value:'$M',angle:-90,position:'insideLeft',fill:'#a8a29e',fontSize:10}}/>{tip}<Legend wrapperStyle={{fontSize:10}}/>
              <Bar dataKey="Deposit" fill="#34d399"/>
              <Bar dataKey="Event Cost" fill="#f87171"/>
              <Line type="stepAfter" dataKey="Balance" stroke="#fb923c" strokeWidth={2} dot={false}/>
            </ComposedChart>
          </ChartBox>
          <ChartBox title="O&M Reserve" note={`${ca2.omMode==='initial'?'Initial-funded':'Funded from operating cash'} · target tracks forward opex`}>
            <ComposedChart data={mkData(null,[{name:'Deposit',arr:ca2.om?.deposit||[]},{name:'Balance',arr:ca2.om?.balance||[]}])}>
              {grid}<XAxis dataKey="period" {...axisProps} interval={tick}/><YAxis {...axisProps} label={{value:'$M',angle:-90,position:'insideLeft',fill:'#a8a29e',fontSize:10}}/>{tip}<Legend wrapperStyle={{fontSize:10}}/>
              <Bar dataKey="Deposit" fill="#34d399"/>
              <Line type="stepAfter" dataKey="Balance" stroke="#60a5fa" strokeWidth={2} dot={false}/>
            </ComposedChart>
          </ChartBox>
          <ChartBox title="Ramp-up Reserve" note="Funded at SC; releases over the ramp-up period to support early-year coverage.">
            <ComposedChart data={mkData(null,[{name:'Release',arr:ca2.rampAcct?.release||[]},{name:'Balance',arr:ca2.rampAcct?.balance||[]}])}>
              {grid}<XAxis dataKey="period" {...axisProps} interval={tick}/><YAxis {...axisProps} label={{value:'$M',angle:-90,position:'insideLeft',fill:'#a8a29e',fontSize:10}}/>{tip}<Legend wrapperStyle={{fontSize:10}}/>
              <Bar dataKey="Release" fill="#a78bfa"/>
              <Line type="stepAfter" dataKey="Balance" stroke="#c4b5fd" strokeWidth={2} dot={false}/>
            </ComposedChart>
          </ChartBox>
        </>;
      })()}
    </Section>
  </div>;
}


function OptimizerTab({model, setModel, results}){
  const o = model.optimizer;
  const setO = patch => setModel({...model, optimizer:{...o, ...patch}});
  const setCascade = patch => setO({cascade:{...(o.cascade||{}), ...patch}});
  const c = o.cascade || {};
  const ap = c.autoTifiaParams || {};
  const setAuto = patch => setCascade({autoTifiaParams: {...ap, ...patch}});
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState(o.lastAutoCascadeRun);
  const ppy = model.general.periodsPerYear || 2;
  const tifiaInst = model.financing.instruments.find(i => i.id === c.tifiaInstrumentId) || model.financing.instruments.find(i => i.type === 'TIFIA Loan');
  const tifiaTenor = tifiaInst ? tifiaInst.tenorYears : 35;
  const sculptYears = Math.max(0, tifiaTenor - (ap.deferYears || 0) - (ap.ioYears || 0) - (ap.testYearsBeforeMaturity || 10));

  const runOpt = () => {
    setRunning(true);
    setTimeout(()=>{
      const params = {
        tifiaEnabled: c.tifiaEnabled !== false,
        tifiaInstrumentId: c.tifiaInstrumentId,
        tifiaEligibleCapexIds: c.tifiaEligibleCapexIds || [],
        pabInstrumentId: c.pabInstrumentId,
        plugInstrumentId: c.plugInstrumentId,
        equityInstrumentId: c.equityInstrumentId,
        targetEquityIRR: c.targetEquityIRR,
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
      const r = model.general.governmentSupportMode === 'ap'
        ? autoCascadeAP(model, params)
        : autoCascadeTifia(model, params);
      const runSummary = {bestPct: r.best?.pct, bestTifia: r.best?.tifiaAmount, bestPab: r.best?.pabAmount, bestSubsidy: r.best?.upfrontSubsidy, bestAP: r.best?.apBasePerPeriod, diagnosis: r.best?.phaseInfo?.diagnosis, converged: r.converged};
      setOutput(r);
      // AUTO-APPLY: commit optimized stack to model AND persist the run summary in the same update
      // (workingModel is a pre-run clone, so we must merge lastAutoCascadeRun into it or VfM/others lose it)
      if(r.best && r.best.workingModel){
        setModel({...r.best.workingModel,
          optimizer: {...r.best.workingModel.optimizer, ...o, cascade: o.cascade, lastAutoCascadeRun: runSummary}});
      } else {
        setO({lastAutoCascadeRun: runSummary});
      }
      setRunning(false);
    }, 50);
  };
  const applyOpt = () => {
    if(!output || !output.best || !output.best.workingModel) return;
    const runSummary = {bestPct: output.best?.pct, bestTifia: output.best?.tifiaAmount, bestPab: output.best?.pabAmount, bestSubsidy: output.best?.upfrontSubsidy, bestAP: output.best?.apBasePerPeriod, converged: output.converged};
    setModel({...output.best.workingModel,
      optimizer: {...output.best.workingModel.optimizer, ...o, cascade: o.cascade, lastAutoCascadeRun: runSummary}});
  };

  const eligibleIds = c.tifiaEligibleCapexIds || [];
  const toggleEligible = (id) => {
    const newIds = eligibleIds.includes(id) ? eligibleIds.filter(x=>x!==id) : [...eligibleIds, id];
    setCascade({tifiaEligibleCapexIds: newIds});
  };
  let eligiblePreview = 0;
  if(results && results.capexSched){
    for(const id of eligibleIds){ eligiblePreview += sum(results.capexSched.byItem[id] || []); }
  }

  return <div>
    <Section title="TIFIA Cascade Optimizer"
      subtitle="Sizes TIFIA first to its statutory or DSCR ceiling (whichever binds), then PAB only if TIFIA at 49% and gap remains. TIFIA amortization is auto-structured: CapI → IO → Sculpt → Level-to-Maturity. The 50% balance test passes by construction.">
      <div className="bg-amber-500/5 border border-amber-500/30 rounded p-3 mb-4 text-xs text-amber-200">
        <span className="font-medium">Logic:</span> 1) TIFIA = min(49% × eligible, max where Total DSCR ≥ floor + 50% test passes) · 2) PAB = min(gap, max at Sr DSCR floor) only if TIFIA hit 49% · 3) Equity = plug.
      </div>
    </Section>

    <Section title="Step 1 · TIFIA Terms + Amortization Profile"
      subtitle={`Tenor: ${tifiaTenor}y (${tifiaTenor*ppy} periods at ${ppy}/yr). Amount is set by the optimizer — configure rate, fees, and phase profile here.`}
      action={
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-xs text-stone-400">{c.tifiaEnabled !== false ? 'TIFIA ON' : 'TIFIA OFF'}</span>
          <button onClick={()=>{
            const turningOff = c.tifiaEnabled !== false;
            const newInsts = model.financing.instruments.map(i => {
              if(i.id !== (c.tifiaInstrumentId||'tifia1')) return i;
              if(turningOff) return {...i, _savedAmount: i.amount, amount: 0};
              return {...i, amount: i._savedAmount != null ? i._savedAmount : i.amount};
            });
            setModel({...model,
              financing:{...model.financing, instruments:newInsts},
              optimizer:{...o, cascade:{...(o.cascade||{}), tifiaEnabled: !turningOff}}});
          }}
            className={`w-12 h-6 rounded-full transition-colors ${c.tifiaEnabled !== false ? 'bg-amber-500' : 'bg-stone-700'} relative`}>
            <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${c.tifiaEnabled !== false ? 'translate-x-7' : 'translate-x-1'}`}/>
          </button>
        </label>
      }>
      {/* TIFIA instrument terms — shown here instead of Financing tab */}
      {tifiaInst && (()=>{
        const updateTifia = patch => setModel({...model, financing:{...model.financing, instruments: model.financing.instruments.map(i => i.id === tifiaInst.id ? {...i,...patch} : i)}});
        return <div className={`bg-stone-900/40 border border-amber-500/20 rounded p-3 mb-4 ${c.tifiaEnabled === false ? 'opacity-40 pointer-events-none' : ''}`}>
          <div className="text-[10px] uppercase tracking-wider text-amber-400 mb-3">Instrument Terms (optimizer controls amount)</div>
          <div className="grid grid-cols-4 gap-3 mb-3">
            <Field label="Rate (%)" hint="Fixed coupon rate"><NumInput value={tifiaInst.rate} onChange={v=>updateTifia({rate:v})} step={0.0025} suffix="%"/></Field>
            <Field label="Tenor (yrs)"><NumInput value={tifiaInst.tenorYears} onChange={v=>updateTifia({tenorYears:v})}/></Field>
            <Field label="Close Date"><TextInput value={tifiaInst.closeDate} onChange={v=>updateTifia({closeDate:v})}/></Field>
            <Field label="Day Count"><Select value={tifiaInst.dayCount} onChange={v=>updateTifia({dayCount:v})} options={DAY_COUNT}/></Field>
            <Field label="Draw Priority"><NumInput value={tifiaInst.drawdownPriority} onChange={v=>updateTifia({drawdownPriority:v})}/></Field>
            <Field label="Issuance Cost ($)" hint="Base-year amount, escalated to FC"><NumInput value={tifiaInst.issuanceCost} onChange={v=>updateTifia({issuanceCost:v})} prefix="$"/></Field>
            <Field label="Issuance Cost Esc (%/yr)"><NumInput value={tifiaInst.issuanceCostEscalation} onChange={v=>updateTifia({issuanceCostEscalation:v})} step={0.005} suffix="%"/></Field>
            <Field label="Covenants / Notes"><TextInput value={tifiaInst.covenants} onChange={v=>updateTifia({covenants:v})}/></Field>
          </div>
          <div className="text-[10px] text-stone-500">Admin fee, monitoring fee, 50% test enforcement → TIFIA tab. Amount shown: {fmt$(tifiaInst.amount)} (overwritten by Run).</div>
        </div>;
      })()}
      {/* Amortization profile */}
      {c.tifiaEnabled === false && (
        <div className="bg-stone-800/60 border border-stone-600 rounded p-3 mb-3 text-sm text-stone-400">
          ⊘ TIFIA disabled — optimizer will skip Step 1 and size PABs directly to fill the funding gap (Steps 2–4 run normally).
        </div>
      )}
      <div className={`${c.tifiaEnabled === false ? 'opacity-40 pointer-events-none' : ''}`}>
      <div className="text-[10px] uppercase tracking-wider text-stone-400 mb-3">Amortization Profile — Auto-builds 4 phases that pass the 50% test by construction</div>
      <div className="grid grid-cols-4 gap-4">
        <Field label="Phase 1 — CapI (years)" hint="Interest capitalizes into balance"><NumInput value={ap.deferYears} onChange={v=>setAuto({deferYears:v})} step={1} suffix="y"/></Field>
        <Field label="Phase 2 — IO (years)" hint="Pay interest only"><NumInput value={ap.ioYears} onChange={v=>setAuto({ioYears:v})} step={1} suffix="y"/></Field>
        <Field label="Phase 3 — Sculpt span" hint="Auto-derived"><div className="text-sm text-stone-300 font-mono py-2">{sculptYears.toFixed(1)} y</div></Field>
        <Field label="Phase 4 — Level (years to maturity)" hint="Last X years; balance must = 50% at start of this phase (10y is TIFIA statute)"><NumInput value={ap.testYearsBeforeMaturity} onChange={v=>setAuto({testYearsBeforeMaturity:v})} step={1} suffix="y"/></Field>
      </div>
      <div className="grid grid-cols-2 gap-4 mt-3">
        <Field label="Phase 3 — Sculpt Mode"
          hint="Annuity = deterministic level pmt to 50% balance. Sculpt = DSCR-driven (falls back to annuity if CFADS infeasible)">
          <Select value={ap.phase3Mode} onChange={v=>setAuto({phase3Mode:v})} options={['annuity','sculpt']}/>
        </Field>
      </div>
      <div className="mt-4 flex h-6 rounded overflow-hidden border border-stone-700/60">
        {(()=>{
          const segs = [
            {label:`CapI ${ap.deferYears}y`, w: (ap.deferYears||0)/tifiaTenor, c:'#475569'},
            {label:`IO ${ap.ioYears}y`, w: (ap.ioYears||0)/tifiaTenor, c:'#fbbf24'},
            {label:`Sculpt ${sculptYears.toFixed(0)}y`, w: sculptYears/tifiaTenor, c:'#a78bfa'},
            {label:`Level ${ap.testYearsBeforeMaturity}y`, w: (ap.testYearsBeforeMaturity||0)/tifiaTenor, c:'#10b981'},
          ];
          return segs.map((s,i)=>(
            <div key={i} style={{width:`${s.w*100}%`, background:s.c}} className="flex items-center justify-center text-[9px] font-medium text-stone-950 px-1">
              {s.w > 0.06 ? s.label : ''}
            </div>
          ));
        })()}
      </div>
      </div>{/* end conditional amortization wrapper */}
    </Section>

    <Section title="Step 2 · TIFIA-Eligible Capex Items"
      subtitle={`Items checked here count toward the TIFIA % cap. Eligible total: ${fmt$(eligiblePreview)} of ${fmt$(sum(results?.capexSched?.monthly || []))}.`}>
      <div className="grid grid-cols-3 gap-x-3 gap-y-1 max-h-64 overflow-y-auto p-2 bg-stone-900/40 border border-stone-700/60 rounded">
        {model.capex.items.map(it => {
          const itemTotal = results && results.capexSched ? sum(results.capexSched.byItem[it.id] || []) : 0;
          return <label key={it.id} className="flex items-center gap-2 px-2 py-1 hover:bg-stone-800/60 rounded cursor-pointer">
            <input type="checkbox" checked={eligibleIds.includes(it.id)} onChange={()=>toggleEligible(it.id)} className="accent-amber-500"/>
            <span className="text-xs text-stone-300 flex-1 truncate">{it.label}</span>
            <span className="text-[10px] text-stone-500 font-mono">{fmt$(itemTotal)}</span>
          </label>;
        })}
      </div>
    </Section>

    <Section title="Step 3 · Constraint Floors + Equity Target"
      subtitle="TIFIA binary-searched for max % that satisfies ALL three DSCR floors AND the 50% test. Equity sized to target IRR. Plug fills residual.">
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Field label="Min TIFIA % (search floor)"><NumInput value={ap.minTifiaPct} onChange={v=>setAuto({minTifiaPct:v})} step={0.01} suffix="%"/></Field>
        <Field label="Max TIFIA % (statute cap)" hint="49% is the federal statutory cap"><NumInput value={ap.maxTifiaPct} onChange={v=>setAuto({maxTifiaPct:v})} step={0.01} suffix="%"/></Field>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <Field label="Min Total DSCR (Sr + TIFIA)" hint="Primary TIFIA-sizing constraint"><NumInput value={ap.minTotalDSCR} onChange={v=>setAuto({minTotalDSCR:v})} step={0.05}/></Field>
        <Field label="Min Senior DSCR" hint="Binds PAB sizing when TIFIA at 49%"><NumInput value={ap.minSrDSCR} onChange={v=>setAuto({minSrDSCR:v})} step={0.05}/></Field>
        <Field label="Min TIFIA Eff DSCR" hint="(CFADS − Sr DS) / TIFIA DS"><NumInput value={ap.minTifiaDSCR} onChange={v=>setAuto({minTifiaDSCR:v})} step={0.05}/></Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Target Equity IRR" hint="Equity sized to NPV(distributable CF) @ this rate"><NumInput value={c.targetEquityIRR} onChange={v=>setCascade({targetEquityIRR:v})} step={0.005} suffix="%"/></Field>
        <Field label="Equity Instrument"><Select value={c.equityInstrumentId} onChange={v=>setCascade({equityInstrumentId:v})} options={model.financing.instruments.filter(i=>i.seniority==='Equity').map(i=>i.id)}/></Field>
        <Field label="Plug Instrument" hint="Absorbs any residual funding gap after debt + equity"><Select value={c.plugInstrumentId} onChange={v=>setCascade({plugInstrumentId:v})} options={model.financing.instruments.map(i=>i.id)}/></Field>
      </div>
    </Section>

    <Section title="Step 4 · Run"
      subtitle="Run sizes TIFIA → PAB → Equity (to target IRR) → Upfront Subsidy (plug). Stack is auto-applied to the model so Dashboard, Cashflow, Sensitivity all reflect the result.">
      <div className="flex items-center gap-3">
        <button onClick={runOpt} disabled={running}
          className="px-6 py-3 bg-amber-500 text-stone-900 rounded text-sm font-medium hover:bg-amber-400 disabled:opacity-50">
          {running ? 'Running…' : '▶ Run Cascade & Apply'}
        </button>
        {output && output.best && <button onClick={applyOpt}
          className="px-6 py-3 bg-emerald-500/10 border border-emerald-500/50 text-emerald-300 rounded text-sm hover:bg-emerald-500/20">
          ↺ Re-apply Last Result
        </button>}
      </div>
    </Section>

    {output && (
      <Section title="Result" subtitle={output.converged ? `Converged in ${output.trace.length} iterations` : 'Did not converge'}>
        {output.error && <div className="p-3 bg-rose-900/20 border border-rose-700/50 rounded text-rose-300 text-sm mb-3">Error: {output.error}</div>}
        {output.best && (()=>{
          const b = output.best;
          const atCeiling = b.pct >= (ap.maxTifiaPct - 0.005);
          return <>
            <div className="grid grid-cols-4 gap-3 mb-4">
              <Metric label="TIFIA %" value={fmtPct(b.pct, 2)} accent="amber" sub={atCeiling ? '49% statutory ceiling' : 'Constraint-bound below 49%'}/>
              <Metric label="TIFIA Principal" value={fmt$(b.tifiaAmount)} accent="amber" sub={`of ${fmt$(b.eligibleCost)} eligible`}/>
              <Metric label="PAB Sized to" value={fmt$(b.pabAmount)} accent={b.pabAmount > 0 ? 'amber' : 'stone'} sub={b.pabAmount > 0 ? 'fills funding gap' : 'no PAB needed'}/>
              <Metric label="Funding Gap" value={fmt$(b.finalGap)} accent={Math.abs(b.finalGap) < 1e6 ? 'green' : 'amber'} sub="post plug-grant"/>
            </div>
            <div className="grid grid-cols-4 gap-3 mb-4">
              <Metric label="Equity Sized to" value={fmt$(b.equityAmount)} accent="amber" sub={`@ target IRR ${fmtPct(b.targetEquityIRR||0,1)}`}/>
              <Metric label="Equity@IRR NPV" value={fmt$(b.equityForIRRCalc)} sub={b.equityAmount < b.equityForIRRCalc ? 'capped by gap' : 'binds IRR'}/>
              <Metric label="Actual Equity IRR" value={fmtPct(b.actualEquityIRR||0,2)} accent={(b.actualEquityIRR||0) >= (b.targetEquityIRR||0)-0.005 ? 'green' : 'amber'} sub={`vs target ${fmtPct(b.targetEquityIRR||0,1)}`}/>
              <Metric label="Plug Absorbed" value={fmt$(b.plugApplied||0)} sub="rounding residual"/>
            </div>
            <div className="grid grid-cols-1 gap-3 mb-4">
              {model.general.governmentSupportMode === 'ap' ? (
                <div className="bg-gradient-to-r from-emerald-500/10 to-emerald-500/5 border-2 border-emerald-500/40 rounded-lg p-4">
                  <div className="text-[10px] uppercase tracking-widest text-emerald-400 mb-1">Final Output — Availability Payment (per period, base)</div>
                  <div className="text-3xl font-light text-emerald-300">{fmt$(b.apBasePerPeriod||0)}</div>
                  <div className="text-xs text-stone-400 mt-1">
                    Level base payment escalating at {fmtPct(b.apEscalation||0,1)}/yr. Sized to meet whichever binds: <span className="text-emerald-300">{b.apBinding}</span>.
                    Structure: TIFIA={fmtPct(b.pct,1)} (full 49%), PAB={fmt$(b.pabAmount)} (to {fmtPct(b.targetGearing||0,0)} gearing), Equity@{fmtPct(b.targetEquityIRR||0,1)} IRR. No upfront subsidy.
                  </div>
                </div>
              ) : (
                <div className="bg-gradient-to-r from-amber-500/10 to-amber-500/5 border-2 border-amber-500/40 rounded-lg p-4">
                  <div className="text-[10px] uppercase tracking-widest text-amber-400 mb-1">Final Output — Upfront Subsidy Required</div>
                  <div className="text-3xl font-light text-amber-300">{fmt$(b.upfrontSubsidy||0)}</div>
                  <div className="text-xs text-stone-400 mt-1">Government / sponsor cash needed at financial close to make the deal bankable at TIFIA={fmtPct(b.pct,1)}, PAB={fmt$(b.pabAmount)}, Equity@{fmtPct(b.targetEquityIRR||0,1)} IRR. This is the project's headline ask.</div>
                </div>
              )}
            </div>
            <div className="grid grid-cols-4 gap-3 mb-4">
              <Metric label="Min Total DSCR" value={fmtRatio(b.minTotalDSCR)} accent={!b.minTotalDSCR || b.minTotalDSCR >= (ap.minTotalDSCR||1.10) ? 'green' : 'red'} sub={`floor ${(ap.minTotalDSCR||1.10).toFixed(2)}x`}/>
              <Metric label="Min Senior DSCR" value={(b.minSrDSCR && b.minSrDSCR >= 998) ? '—' : fmtRatio(b.minSrDSCR)} accent={!b.minSrDSCR || b.minSrDSCR >= (ap.minSrDSCR||1.30) ? 'green' : 'red'} sub={(b.minSrDSCR && b.minSrDSCR >= 998) ? 'no senior debt (PAB=0)' : `floor ${(ap.minSrDSCR||1.30).toFixed(2)}x`}/>
              <Metric label="Min TIFIA Eff DSCR" value={fmtRatio(b.minTifiaEffDSCR)} accent={!b.minTifiaEffDSCR || b.minTifiaEffDSCR >= (ap.minTifiaDSCR||1.10) ? 'green' : 'red'} sub={`floor ${(ap.minTifiaDSCR||1.10).toFixed(2)}x`}/>
              <Metric label="Test Point Balance" value={fmt$(b.testBalAtPoint)} accent={b.testPassed ? 'green' : 'red'} sub={`target 50% = ${fmt$(0.5*b.tifiaAmount)} · ${b.testPassed ? 'PASS' : 'FAIL'}`}/>
            </div>
            <div className="bg-stone-900/40 border border-amber-500/30 rounded p-3 mb-3">
              <div className="text-[11px] uppercase tracking-wider text-amber-300 mb-1">Phase Structure</div>
              <div className="text-xs text-stone-300">{b.phaseInfo?.diagnosis}</div>
              {b.phaseInfo?.fallbackUsed && <div className="text-xs text-amber-400 mt-1">⚠ Sculpt CFADS-infeasible — fell back to annuity</div>}
              <div className="mt-2 flex h-6 rounded overflow-hidden border border-stone-700/60">
                {(b.phaseInfo?.phases || []).map((p, idx) => {
                  const startP = idx === 0 ? 0 : (b.phaseInfo.phases[idx-1].endPeriod || 0);
                  const lastEnd = b.phaseInfo.phases[b.phaseInfo.phases.length-1].endPeriod;
                  const widthPct = ((p.endPeriod - startP) / Math.max(1, lastEnd)) * 100;
                  const colors = {defer:'#475569', io:'#fbbf24', sculpt:'#a78bfa', level:'#10b981', 'equal-principal':'#fb7185'};
                  return <div key={idx} style={{width:`${widthPct}%`, background:colors[p.regime]||'#666'}}
                    className="flex items-center justify-center text-[9px] font-medium text-stone-950 px-1"
                    title={`${p.regime} (${startP}→${p.endPeriod})${p.targetDSCR?` @ ${p.targetDSCR.toFixed(2)}x`:''}`}>
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
                <tbody>{output.trace.map((t,i)=>(
                  <tr key={i} className={`hover:bg-stone-900/40 ${t.feasible?'':'opacity-60'}`}>
                    <TD>{t.iter}</TD>
                    <TD className="text-right text-amber-300">{fmtPct(t.pct,2)}</TD>
                    <TD className="text-right text-stone-300">{fmt$(t.tifiaAmount)}</TD>
                    <TD className="text-right text-stone-300">{fmt$(t.pabAmount)}</TD>
                    <TD className="text-right text-stone-300">{fmtRatio(t.minTotalDSCR)}</TD>
                    <TD className="text-right text-stone-300">{(t.minSrDSCR && t.minSrDSCR >= 998) ? '—' : fmtRatio(t.minSrDSCR)}</TD>
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
  </div>;
}

// ---------- CFRow helper ----------
function CFRow({label, data, positive, negative, bold, ratio, raw}){
  return <tr className={`hover:bg-stone-900/40 ${bold?'bg-stone-900/40':''}`}>
    <TD mono={false} className={`sticky left-0 bg-stone-950 ${bold?'text-stone-100 font-medium':'text-stone-300'}`}>{label}</TD>
    {data.map((v,i)=>(
      <TD key={i} className={`text-right ${positive?'text-emerald-300':''} ${negative?'text-rose-300':''} ${bold?'font-medium':''}`}>
        {ratio?(v==null||!isFinite(v)?'—':`${v.toFixed(2)}x`):raw?(v!=null?v.toLocaleString():'—'):fmt$(v)}
      </TD>))}
  </tr>;
}

// ---------- DASHBOARD ----------
function DashboardTab({model, results}){
  if(!results) return <div className="p-8 text-center text-stone-500">Loading model…</div>;
  const r = results;
  const gap = r.totalUses - r.totalSources;
  const minSr = r.minSeniorDSCR;
  const minTot = r.totalDSCR ? Math.min(...r.totalDSCR.filter(v=>v!=null && isFinite(v))) : null;

  // ── Excel export via ExcelJS (full styling + formula support) ──────────────
  const [exporting, setExporting] = useState(false);

  const loadExcelJS = () => new Promise((resolve, reject) => {
    if(window.ExcelJS){ resolve(window.ExcelJS); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
    s.onload  = () => resolve(window.ExcelJS);
    s.onerror = () => reject(new Error('ExcelJS CDN load failed'));
    document.head.appendChild(s);
  });

  const exportXLSX = async () => {
    setExporting(true);
    try {
      const EJS = await loadExcelJS();
      const wb  = new EJS.Workbook();
      wb.creator = 'Toll Road PF Model';
      wb.created = new Date();
      wb.views = [{ x:0, y:0, width:20000, height:15000, firstSheet:0, activeTab:0, visibility:'visible' }];

      // ── Colour palette (ARGB strings) ──
      const C = {
        darkBg:'FF1C1917', medBg:'FF292524', rowAlt:'FFF5F5F4',
        amber:'FFFBBF24',  amberBg:'FFFFF8E1', amberDark:'FFF59E0B',
        green:'FF16A34A',  greenBg:'FFF0FDF4',
        red:'FFDC2626',    redBg:'FFFEF2F2',
        blue:'FF3B82F6',   violet:'FFA78BFA',
        stone:'FF78716C',  white:'FFFFFFFF',
        border:'FFD6D3D1', borderDark:'FF78716C',
      };

      // ── Style helpers ──
      const hdr = (cell, txt, bg=C.darkBg, fg=C.amber, sz=11, bold=true) => {
        cell.value = txt;
        cell.font  = { bold, size:sz, color:{argb:fg} };
        cell.fill  = { type:'pattern', pattern:'solid', fgColor:{argb:bg} };
        cell.alignment = { vertical:'middle', horizontal:'left', wrapText:true };
        cell.border = { bottom:{style:'thin', color:{argb:C.borderDark}} };
      };
      const colHdr = (cell, txt) => {
        cell.value = txt;
        cell.font  = { bold:true, size:10, color:{argb:C.white} };
        cell.fill  = { type:'pattern', pattern:'solid', fgColor:{argb:C.medBg} };
        cell.alignment = { vertical:'middle', horizontal:'right', wrapText:true };
        cell.border = { bottom:{style:'medium', color:{argb:C.amber}},
                        right:{style:'thin', color:{argb:C.border}} };
      };
      const rowHdr = (cell, txt, indent=0) => {
        cell.value = '  '.repeat(indent) + txt;
        cell.font  = { size:10, color:{argb:C.medBg.replace('FF','FF4A4A4A')||'FF404040'} };
        cell.alignment = { vertical:'middle', horizontal:'left' };
      };
      const money = (cell, val, formula=null) => {
        cell.value = formula ? {formula, result:val} : val;
        cell.numFmt = '$#,##0';
        cell.font = { size:10 };
        cell.alignment = { horizontal:'right' };
      };
      const moneyM = (cell, val, formula=null) => {
        cell.value = formula ? {formula, result:val} : val;
        cell.numFmt = '"$"#,##0.00,"M"';
        cell.font = { size:10 };
        cell.alignment = { horizontal:'right' };
      };
      const pct = (cell, val) => {
        cell.value = val;
        cell.numFmt = '0.00%';
        cell.font = { size:10 };
        cell.alignment = { horizontal:'right' };
      };
      const ratio = (cell, val, formula=null) => {
        cell.value = formula ? {formula, result:val??''} : (val??'');
        cell.numFmt = '0.00"x"';
        cell.font = { size:10 };
        cell.alignment = { horizontal:'right' };
      };
      const setBorder = (cell) => {
        cell.border = { top:{style:'thin',color:{argb:C.border}},
          left:{style:'thin',color:{argb:C.border}},
          bottom:{style:'thin',color:{argb:C.border}},
          right:{style:'thin',color:{argb:C.border}} };
      };
      const setRowFill = (row, argb) => row.eachCell(c => {
        c.fill = {type:'pattern', pattern:'solid', fgColor:{argb}};
      });
      const sectionHdr = (ws, rowNum, txt) => {
        const row = ws.getRow(rowNum);
        const cell = row.getCell(1);
        cell.value = txt;
        cell.font = {bold:true, size:11, color:{argb:C.amber}};
        cell.fill = {type:'pattern', pattern:'solid', fgColor:{argb:C.medBg}};
        cell.alignment = {vertical:'middle'};
        row.height = 20;
        return rowNum + 1;
      };
      const addKV = (ws, rn, label, val, fmt='text', formula=null) => {
        const r = ws.getRow(rn);
        const lc = r.getCell(1); lc.value = label;
        lc.font = {size:10}; lc.alignment = {horizontal:'left'};
        const vc = r.getCell(2);
        if(fmt==='money')       money(vc, val, formula);
        else if(fmt==='moneyM') moneyM(vc, val, formula);
        else if(fmt==='pct')    pct(vc, val);
        else if(fmt==='ratio')  ratio(vc, val, formula);
        else { vc.value = val; vc.font={size:10}; vc.alignment={horizontal:'right'}; }
        r.eachCell(c => setBorder(c));
        return rn + 1;
      };

      const lastRun = model.optimizer?.lastAutoCascadeRun || {};

      // ════════════════════════════════════════
      // SHEET 1 — COVER
      // ════════════════════════════════════════
      const wsCover = wb.addWorksheet('Cover', {
        views:[{showGridLines:false}],
        pageSetup:{paperSize:9, orientation:'portrait'}
      });
      wsCover.columns = [{width:30},{width:22},{width:22},{width:22},{width:22}];
      // Title block
      wsCover.mergeCells('A1:E1');
      const titleCell = wsCover.getCell('A1');
      titleCell.value = 'TOLL ROAD PROJECT FINANCE MODEL';
      titleCell.font = {bold:true, size:20, color:{argb:C.amber}};
      titleCell.fill = {type:'pattern', pattern:'solid', fgColor:{argb:C.darkBg}};
      titleCell.alignment = {vertical:'middle', horizontal:'center'};
      wsCover.getRow(1).height = 42;

      wsCover.mergeCells('A2:E2');
      const subTitle = wsCover.getCell('A2');
      subTitle.value = `${model.general.projectName || 'I-XXX Express Lanes'}  ·  ${model.general.state || 'TX'}  ·  ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}`;
      subTitle.font = {size:12, color:{argb:'FFA8A29E'}};
      subTitle.fill = {type:'pattern', pattern:'solid', fgColor:{argb:C.darkBg}};
      subTitle.alignment = {horizontal:'center', vertical:'middle'};
      wsCover.getRow(2).height = 24;

      // Key metrics cards
      const metrics = [
        ['Upfront Subsidy Required', lastRun.bestSubsidy, 'money', C.amberBg, C.amberDark],
        ['TIFIA Sized',              lastRun.bestTifia,   'money', 'FFF3F4F6', C.medBg],
        ['PAB Sized',                lastRun.bestPab,     'money', 'FFF3F4F6', C.medBg],
        ['Equity IRR (Target)',      model.optimizer?.cascade?.targetEquityIRR, 'pct', C.greenBg, C.green],
        ['Min Total DSCR',           r.totalDSCR ? Math.min(...r.totalDSCR.filter(v=>v&&isFinite(v))) : null, 'ratio', 'FFF3F4F6', C.medBg],
        ['TIFIA All-in Rate',        r.tifiaAllInRate, 'pct', 'FFF3F4F6', C.medBg],
        ['Total Uses',               r.totalUses, 'money', 'FFF3F4F6', C.medBg],
        ['Concession Period',        `${model.general.concessionYears}y`, 'text', 'FFF3F4F6', C.medBg],
        ['Operations Period',        `${model.general.operationsYears}y`, 'text', 'FFF3F4F6', C.medBg],
        ['Periods per Year',         model.general.periodsPerYear === 2 ? 'Semi-Annual' : 'Annual', 'text', 'FFF3F4F6', C.medBg],
      ];
      let mRow = 4;
      metrics.forEach(([label, val, fmt, bg, fg]) => {
        if(!val && val !== 0) return;
        const r2 = wsCover.getRow(mRow);
        const lc = r2.getCell(1);
        lc.value = label;
        lc.font = {size:11, color:{argb:'FF374151'}};
        lc.fill = {type:'pattern', pattern:'solid', fgColor:{argb:bg}};
        lc.alignment = {vertical:'middle', indent:1};
        const vc = r2.getCell(2);
        vc.fill = {type:'pattern', pattern:'solid', fgColor:{argb:bg}};
        if(fmt==='money'){ money(vc,val); vc.font={size:12,bold:true,color:{argb:'FF'+fg.replace('FF','')}}; }
        else if(fmt==='pct'){ pct(vc,val); vc.font={size:12,bold:true,color:{argb:fg}}; }
        else if(fmt==='ratio'){ ratio(vc,val); vc.font={size:12,bold:true,color:{argb:fg}}; }
        else { vc.value=val; vc.font={size:12,bold:true,color:{argb:fg}}; vc.alignment={horizontal:'right'}; }
        r2.height = 26;
        [1,2].forEach(c => { r2.getCell(c).border = {bottom:{style:'thin',color:{argb:C.border}}}; });
        mRow++;
      });

      // Sheet index
      mRow += 2;
      sectionHdr(wsCover, mRow++, 'Workbook Contents');
      [['Assumptions','All model inputs — General, Revenue, Opex, Capex, Financing'],
       ['Sources & Uses','Construction draw schedule by period + S&U summary'],
       ['Cashflow','Full operating period cashflow with DSCR formulas'],
       ['TIFIA Schedule','TIFIA amortization table — opening/closing balance + cap interest'],
       ['Outputs','Optimizer results — TIFIA sizing, equity IRR, upfront subsidy'],
      ].forEach(([sheet, desc]) => {
        const r2 = wsCover.getRow(mRow++);
        const nc = r2.getCell(1);
        nc.value = sheet;
        nc.font = {bold:true, size:10, color:{argb:C.blue}, underline:true};
        const dc = r2.getCell(2);
        dc.value = desc;
        dc.font = {size:10, color:{argb:C.stone}};
        r2.height = 18;
      });

      // ════════════════════════════════════════
      // SHEET 2 — ASSUMPTIONS
      // ════════════════════════════════════════
      const wsAsm = wb.addWorksheet('Assumptions', {views:[{showGridLines:false}]});
      wsAsm.columns = [{width:38},{width:20},{width:20},{width:14}];
      let aRow = 1;
      const A = (label, val, fmt='text') => { aRow = addKV(wsAsm, aRow, label, val, fmt); };

      aRow = sectionHdr(wsAsm, aRow, '▸  GENERAL');
      A('Project Name', model.general.projectName||'');
      A('State', model.general.state||'');
      A('Financial Close Date', model.general.financialCloseDate||'');
      A('Construction Months', model.general.constructionMonths);
      A('Operations Years', model.general.operationsYears);
      A('Concession Years', model.general.concessionYears);
      A('Periods per Year', model.general.periodsPerYear);
      aRow++;

      aRow = sectionHdr(wsAsm, aRow, '▸  REVENUE');
      A('AADT Year 1', model.revenue.aadtY1);
      A('AADT Mature', model.revenue.aadtMature);
      A('Year at Mature Traffic', model.revenue.matureYear);
      A('Ramp Curve Type', model.revenue.rampCurve||'S-curve');
      A('Base Toll Rate ($/vehicle)', model.revenue.baseTollRate);
      A('Toll Escalation (%/yr)', model.revenue.tollEscalation, 'pct');
      A('Leakage (%)', model.revenue.leakage||0, 'pct');
      A('Truck Mix (%)', model.revenue.truckMix||0, 'pct');
      A('Truck Toll Multiplier', model.revenue.truckTollMultiplier||1);
      aRow++;

      aRow = sectionHdr(wsAsm, aRow, '▸  OPEX');
      (model.opex.items||[]).forEach(it => {
        A(`${it.label||it.id} (base $/period)`, it.base, 'money');
        A(`  Escalation (%/yr)`, it.escalation||0, 'pct');
      });
      aRow++;

      aRow = sectionHdr(wsAsm, aRow, '▸  CAPEX (BASE $, THEN INFLATED)');
      (model.capex.items||[]).forEach(it => {
        A(`${it.label||it.id}`, it.base, 'money');
        A(`  Inflation (%/yr)`, it.inflRate||0, 'pct');
        A(`  Drawdown Curve`, it.curve||'');
      });
      aRow++;

      aRow = sectionHdr(wsAsm, aRow, '▸  FINANCING INSTRUMENTS');
      model.financing.instruments.forEach(inst => {
        const r2 = wsAsm.getRow(aRow++);
        const c1 = r2.getCell(1); c1.value = `${inst.type} (${inst.id})`;
        c1.font = {bold:true, size:10, color:{argb:C.amberDark}};
        c1.fill = {type:'pattern', pattern:'solid', fgColor:{argb:C.medBg}};
        A('  Amount', inst.amount, 'money');
        A('  Rate (%/yr)', inst.rate||0, 'pct');
        A('  Tenor (yrs)', inst.tenorYears||0);
        A('  Seniority', inst.seniority||'');
        A('  Repayment Style', inst.repaymentStyle||'');
        A('  Drawdown Priority', inst.drawdownPriority||'');
        A('  Issuance Cost ($)', inst.issuanceCost||0, 'money');
        aRow++;
      });
      aRow++;

      aRow = sectionHdr(wsAsm, aRow, '▸  TIFIA CONFIG');
      A('TIFIA Admin Fee ($/yr)', model.tifia?.adminFeeAnnual||0, 'money');
      A('Monitoring Fee (bps)', model.tifia?.monitoringFeeBps||0);
      A('50% Test Years Before Maturity', model.tifia?.fiftyPercentTestYearsBeforeMaturity||10);
      A('Lockup Sr DSCR Trigger', model.tifia?.lockupDSCR||1.20);
      A('Enforce 50% Test', model.tifia?.enforce50PctTest ? 'Yes' : 'No');
      aRow++;

      aRow = sectionHdr(wsAsm, aRow, '▸  CASCADE OPTIMIZER INPUTS');
      A('Target Equity IRR', model.optimizer?.cascade?.targetEquityIRR||0.12, 'pct');
      A('Min Total DSCR', model.optimizer?.cascade?.autoTifiaParams?.minTotalDSCR||1.10, 'ratio');
      A('Min Senior DSCR', model.optimizer?.cascade?.autoTifiaParams?.minSrDSCR||1.30, 'ratio');
      A('Min TIFIA Eff DSCR', model.optimizer?.cascade?.autoTifiaParams?.minTifiaDSCR||1.10, 'ratio');
      A('Max TIFIA % (cap)', model.optimizer?.cascade?.autoTifiaParams?.maxTifiaPct||0.49, 'pct');
      A('TIFIA CapI Years', model.optimizer?.cascade?.autoTifiaParams?.deferYears||5);
      A('TIFIA IO Years', model.optimizer?.cascade?.autoTifiaParams?.ioYears||5);
      A('Test Years Before Maturity', model.optimizer?.cascade?.autoTifiaParams?.testYearsBeforeMaturity||10);

      // Freeze first row, auto-filter
      wsAsm.views = [{state:'frozen', xSplit:0, ySplit:1, showGridLines:false}];

      // ════════════════════════════════════════
      // SHEET 3 — SOURCES & USES
      // ════════════════════════════════════════
      const wsSU = wb.addWorksheet('Sources & Uses', {views:[{showGridLines:false}]});
      wsSU.columns = [{width:36},{width:16},{width:12},...Array(12).fill({width:14})];
      let sRow = 1;

      sRow = sectionHdr(wsSU, sRow, '▸  SOURCES OF FUNDS');
      const suColHdrs = ['Instrument','Type','Seniority','Amount ($)','% of Sources'];
      suColHdrs.forEach((h,c) => colHdr(wsSU.getRow(sRow).getCell(c+1), h));
      const suHdrRow = sRow;
      sRow++;

      const sourceRows = {};
      model.financing.instruments.forEach((inst, idx) => {
        const row = wsSU.getRow(sRow);
        row.getCell(1).value = inst.id; row.getCell(1).font = {size:10};
        row.getCell(2).value = inst.type; row.getCell(2).font = {size:10};
        row.getCell(3).value = inst.seniority; row.getCell(3).font = {size:10};
        money(row.getCell(4), inst.amount);
        sourceRows[inst.id] = sRow;
        row.eachCell(c => { c.border = {bottom:{style:'thin',color:{argb:C.border}}, right:{style:'thin',color:{argb:C.border}}}; });
        // % formula references the instrument amount cell and a total cell (added later)
        const pctCell = row.getCell(5);
        pctCell.value = {formula: `=D${sRow}/D${sRow + model.financing.instruments.length - idx}`, result: inst.amount / Math.max(1, r.totalSources)};
        pctCell.numFmt = '0.0%'; pctCell.font = {size:10}; pctCell.alignment = {horizontal:'right'};
        if(idx % 2 === 1) setRowFill(row, C.rowAlt);
        sRow++;
      });
      // Total Sources row
      const totalSrcRow = wsSU.getRow(sRow);
      totalSrcRow.getCell(1).value = 'TOTAL SOURCES';
      totalSrcRow.getCell(1).font = {bold:true, size:11, color:{argb:C.white}};
      totalSrcRow.getCell(4).value = {formula: `=SUM(D${suHdrRow+1}:D${sRow-1})`, result: r.totalSources};
      totalSrcRow.getCell(4).numFmt = '$#,##0'; totalSrcRow.getCell(4).font = {bold:true, size:11, color:{argb:C.amber}};
      setRowFill(totalSrcRow, C.medBg);
      totalSrcRow.height = 20;
      sRow += 2;

      // Update % formulas now we know total row
      model.financing.instruments.forEach((inst, idx) => {
        const pctCell = wsSU.getRow(sourceRows[inst.id]).getCell(5);
        pctCell.value = {formula: `=D${sourceRows[inst.id]}/D${sRow-2}`, result: inst.amount / Math.max(1, r.totalSources)};
      });

      sRow = sectionHdr(wsSU, sRow, '▸  USES OF FUNDS');
      colHdr(wsSU.getRow(sRow).getCell(1), 'Category');
      colHdr(wsSU.getRow(sRow).getCell(2), 'Amount ($)');
      colHdr(wsSU.getRow(sRow).getCell(3), '% of Uses');
      sRow++;
      const usesData = [
        ['Nominal Capex (inflation-inclusive)', r.capexSched.totalNominal],
        ['Non-TIFIA IDC', r.nonTIFIAIDC],
        ['TIFIA Capitalised Interest', r.tifiaConstr?.capitalizedInterestTotal||0],
        ['Financing Fees (% of debt)', r.financingFees],
        ['Issuance Costs (escalated to FC)', r.totalIssuanceCost],
      ];
      const usesStartRow = sRow;
      usesData.forEach(([label, val], i) => {
        const row = wsSU.getRow(sRow);
        row.getCell(1).value = label; row.getCell(1).font = {size:10};
        money(row.getCell(2), val);
        row.getCell(3).value = {formula:`=B${sRow}/B${usesStartRow+usesData.length}`, result: val/Math.max(1,r.totalUses)};
        row.getCell(3).numFmt = '0.0%'; row.getCell(3).font = {size:10}; row.getCell(3).alignment = {horizontal:'right'};
        row.eachCell(c => setBorder(c));
        if(i%2===1) setRowFill(row, C.rowAlt);
        sRow++;
      });
      const usesTotalRow = wsSU.getRow(sRow);
      usesTotalRow.getCell(1).value = 'TOTAL USES';
      usesTotalRow.getCell(1).font = {bold:true, size:11, color:{argb:C.white}};
      usesTotalRow.getCell(2).value = {formula:`=SUM(B${usesStartRow}:B${sRow-1})`, result:r.totalUses};
      usesTotalRow.getCell(2).numFmt = '$#,##0'; usesTotalRow.getCell(2).font = {bold:true,size:11,color:{argb:C.amber}};
      setRowFill(usesTotalRow, C.medBg);
      usesTotalRow.height = 20;
      sRow++;
      const gapRow = wsSU.getRow(sRow);
      gapRow.getCell(1).value = 'Funding Gap  (Uses − Sources)';
      gapRow.getCell(1).font = {size:10, italic:true};
      const gapVal = r.totalUses - r.totalSources;
      gapRow.getCell(2).value = {formula:`=B${sRow-1}-D${suHdrRow + model.financing.instruments.length + 1}`, result:gapVal};
      gapRow.getCell(2).numFmt = '$#,##0';
      gapRow.getCell(2).font = {bold:true, size:11, color:{argb: Math.abs(gapVal)<1e6 ? C.green : C.red}};
      sRow += 2;

      // Construction draw schedule
      const cm = model.general.constructionMonths;
      const ppy2 = model.general.periodsPerYear;
      const mpp = 12/ppy2;
      const numBkts = Math.ceil(cm/mpp);
      sRow = sectionHdr(wsSU, sRow, '▸  CONSTRUCTION DRAW SCHEDULE (semi-annual)');
      // Header row
      const drHdrRow = wsSU.getRow(sRow++);
      colHdr(drHdrRow.getCell(1), 'Source');
      for(let b=0; b<numBkts; b++){
        const ms = Math.round(b*mpp)+1, me = Math.min(cm, Math.round((b+1)*mpp));
        colHdr(drHdrRow.getCell(b+2), `M${ms}–${me}`);
      }
      colHdr(drHdrRow.getCell(numBkts+2), 'TOTAL');
      // Data rows
      const drInsts = [...model.financing.instruments, {id:'_paygo', type:'Paygo / Availability'}];
      drInsts.forEach((inst, ii) => {
        const draws = inst.id === '_paygo' ? null : (r.drawsByInst||{})[inst.id];
        const paygoMo = r.paygoSched?.monthly||[];
        const bktVals = Array.from({length:numBkts}, (_,b) => {
          const ms=Math.round(b*mpp), me=Math.min(cm,Math.round((b+1)*mpp));
          let v=0; for(let m=ms;m<me;m++) v+= inst.id==='_paygo' ? (paygoMo[m]||0) : (draws?.[m]||0);
          return v;
        });
        if(bktVals.every(v=>v===0)) return;
        const row = wsSU.getRow(sRow);
        row.getCell(1).value = inst.type; row.getCell(1).font={size:10};
        bktVals.forEach((v,b) => { money(row.getCell(b+2), v); });
        // Total formula
        row.getCell(numBkts+2).value = {formula:`=SUM(B${sRow}:${String.fromCharCode(65+numBkts)}${sRow})`, result:bktVals.reduce((a,b)=>a+b,0)};
        row.getCell(numBkts+2).numFmt = '$#,##0';
        row.getCell(numBkts+2).font = {bold:true, size:10, color:{argb:C.amberDark}};
        if(ii%2===1) setRowFill(row, C.rowAlt);
        row.eachCell(c => setBorder(c));
        sRow++;
      });
      // Capex uses row
      const capexRow = wsSU.getRow(sRow);
      capexRow.getCell(1).value = '— Capex Uses —';
      capexRow.getCell(1).font = {bold:true, size:10, color:{argb:C.white}};
      let capexTotal = 0;
      for(let b=0; b<numBkts; b++){
        const ms=Math.round(b*mpp), me=Math.min(cm,Math.round((b+1)*mpp));
        let v=0; for(let m=ms;m<me;m++) v+=r.capexSched.monthly[m]||0;
        money(capexRow.getCell(b+2), v);
        capexRow.getCell(b+2).font = {bold:true, size:10, color:{argb:C.amber}};
        capexTotal += v;
      }
      capexRow.getCell(numBkts+2).value = {formula:`=SUM(B${sRow}:${String.fromCharCode(65+numBkts)}${sRow})`, result:capexTotal};
      capexRow.getCell(numBkts+2).numFmt = '$#,##0'; capexRow.getCell(numBkts+2).font={bold:true, color:{argb:C.amber}};
      setRowFill(capexRow, C.darkBg); capexRow.height = 20;

      wsSU.views = [{state:'frozen', xSplit:1, ySplit:0, showGridLines:false}];

      // ════════════════════════════════════════
      // SHEET 4 — CASHFLOW (formula-driven DSCR)
      // ════════════════════════════════════════
      const wsCF = wb.addWorksheet('Cashflow', {views:[{showGridLines:false}]});
      wsCF.columns = [
        {width:22},{width:16}, // period, date
        {width:14},{width:14},{width:14},{width:14},{width:14}, // rev, opex, cfads, tifia fees, cfads_dscr
        {width:12},{width:12},{width:12}, // sr int, sr pri, sr ds
        {width:12},{width:12},{width:12}, // sub int, sub pri, sub ds
        {width:12},{width:12}, // total ds, ST DS
        {width:10},{width:10}, // sr dscr, total dscr
        {width:14}, // equity CF
      ];
      const cfCols = ['Period','Date','Revenue','Opex','CFADS (Gross)','TIFIA Fees',
        'CFADS for DSCR','Sr Int','Sr Pri','Sr DS','Sub Int','Sub Pri','Sub DS',
        'Total DS','Short-term DS','Sr DSCR','Total DSCR','Equity CF'];
      const cfHdrRow = wsCF.getRow(1);
      cfCols.forEach((h,c) => colHdr(cfHdrRow.getCell(c+1), h));
      cfHdrRow.height = 28;
      wsCF.views = [{state:'frozen', xSplit:2, ySplit:1, showGridLines:false}];

      const cfStartRow = 2;
      r.periods.forEach((p, i) => {
        const ri = cfStartRow + i;
        const row = wsCF.getRow(ri);
        row.height = 16;
        // Cols A-B: label/date
        row.getCell(1).value = p.label; row.getCell(1).font={size:9};
        row.getCell(2).value = p.startDate ? new Date(p.startDate) : ''; row.getCell(2).numFmt='MMM-YY'; row.getCell(2).font={size:9};
        // C: Revenue
        moneyM(row.getCell(3), r.revSched.byPeriod[i]);
        // D: Opex
        moneyM(row.getCell(4), r.opexSched.byPeriod[i]);
        // E: CFADS = Revenue - Opex (formula)
        moneyM(row.getCell(5), (r.revSched.byPeriod[i]||0)-(r.opexSched.byPeriod[i]||0),
          `=C${ri}-D${ri}`);
        row.getCell(5).font = {bold:true, size:9};
        // F: TIFIA Fees
        moneyM(row.getCell(6), (r.tifiaFeesPerPeriod||[])[i]||0);
        // G: CFADS for DSCR = CFADS - TIFIA Fees (formula)
        moneyM(row.getCell(7), (r.cfadsForDscr||r.cfadsByPeriod||[])[i]||0, `=E${ri}-F${ri}`);
        row.getCell(7).font = {bold:true, size:9};
        // H,I: Sr Int, Sr Pri
        moneyM(row.getCell(8), r.seniorInt[i]||0);
        moneyM(row.getCell(9), r.seniorPri[i]||0);
        // J: Sr DS (formula)
        moneyM(row.getCell(10), (r.seniorInt[i]||0)+(r.seniorPri[i]||0), `=H${ri}+I${ri}`);
        // K,L: Sub Int, Sub Pri
        moneyM(row.getCell(11), r.subInt[i]||0);
        moneyM(row.getCell(12), r.subPri[i]||0);
        // M: Sub DS (formula)
        moneyM(row.getCell(13), (r.subInt[i]||0)+(r.subPri[i]||0), `=K${ri}+L${ri}`);
        // N: Total DS (formula)
        moneyM(row.getCell(14), (r.seniorInt[i]||0)+(r.seniorPri[i]||0)+(r.subInt[i]||0)+(r.subPri[i]||0), `=J${ri}+M${ri}`);
        // O: ST DS
        moneyM(row.getCell(15), r.shortDS[i]||0);
        // P: Sr DSCR (formula)
        const srDs = (r.seniorInt[i]||0)+(r.seniorPri[i]||0);
        ratio(row.getCell(16), srDs>0 ? (r.cfadsForDscr||r.cfadsByPeriod||[])[i]/srDs : null,
          `=IF(J${ri}=0,"—",G${ri}/J${ri})`);
        row.getCell(16).font = {size:9, bold:true, color:{argb: srDs>0 && (r.seniorDSCR?.[i]||0)>=1.20 ? C.green : C.red}};
        // Q: Total DSCR (formula)
        const totDs = srDs + (r.subInt[i]||0)+(r.subPri[i]||0);
        ratio(row.getCell(17), totDs>0 ? (r.cfadsForDscr||r.cfadsByPeriod||[])[i]/totDs : null,
          `=IF(N${ri}=0,"—",G${ri}/N${ri})`);
        row.getCell(17).font = {size:9, bold:true, color:{argb: totDs>0 && (r.totalDSCR?.[i]||0)>=1.10 ? C.green : C.red}};
        // R: Equity CF (formula)
        moneyM(row.getCell(18), ((r.rawEquityCF||r.equityCF||[])[i]||0), `=G${ri}-N${ri}-O${ri}`);
        // Alternating row fill
        if(i%2===1) setRowFill(row, C.rowAlt);
        row.eachCell(c => setBorder(c));
      });

      // ════════════════════════════════════════
      // SHEET 5 — TIFIA SCHEDULE (formula-driven balance)
      // ════════════════════════════════════════
      const wsTIFIA = wb.addWorksheet('TIFIA Schedule', {views:[{showGridLines:false}]});
      wsTIFIA.columns = [
        {width:22},{width:10},{width:14},{width:16},
        {width:14},{width:14},{width:14},{width:14},{width:14},{width:16}
      ];
      const tifiaInstObj = model.financing.instruments.find(i=>i.id===(model.tifia?.instrumentId||'tifia1'));
      const tSched = r.debtSchedules?.[model.tifia?.instrumentId||'tifia1'];
      const tConstr = r.tifiaConstr;

      const tiHdrs = ['Period','Phase','Opening Balance','Drawdown','Interest Due',
        'Capitalised Int','Interest Paid','Principal Repaid','Closing Balance','Check'];
      const tiHdrRow = wsTIFIA.getRow(1);
      tiHdrs.forEach((h,c) => colHdr(tiHdrRow.getCell(c+1), h));
      tiHdrRow.height = 28;
      wsTIFIA.views = [{state:'frozen', xSplit:2, ySplit:1, showGridLines:false}];

      const tifc = model.general.financialCloseDate||'2026-07-01';
      const addMonths2 = (ds, n) => { const d=new Date(ds); d.setMonth(d.getMonth()+Math.round(n)); return d; };
      const tifPhases = tifiaInstObj?.phases||[];
      const getPhase = (idx) => { for(const ph of tifPhases) if(idx<ph.endPeriod) return ph.regime; return 'level'; };

      let tiRow = 2;
      // Construction rows (semi-annual buckets)
      const tiMpp = 12/ppy2;
      const tiNumBkts = Math.ceil(cm/tiMpp);
      for(let b=0; b<tiNumBkts; b++){
        const ms=Math.round(b*tiMpp), me=Math.min(cm,Math.round((b+1)*tiMpp));
        const openBal = ms===0 ? 0 : (tConstr?.monthlyBalance?.[ms-1]||0);
        let draws=0, intDue=0;
        for(let m=ms;m<me;m++){ draws+=tConstr?.monthlyDraws?.[m]||0; intDue+=tConstr?.monthlyInterest?.[m]||0; }
        const closeBal = tConstr?.monthlyBalance?.[me-1]||0;
        const row = wsTIFIA.getRow(tiRow);
        row.getCell(1).value = `${addMonths2(tifc,ms).toLocaleDateString('en-US',{month:'short',year:'numeric'})} – ${addMonths2(tifc,me).toLocaleDateString('en-US',{month:'short',year:'numeric'})}`;
        row.getCell(1).font = {size:9};
        row.getCell(2).value = 'Constr'; row.getCell(2).font={size:9,color:{argb:C.stone}};
        money(row.getCell(3), openBal);
        money(row.getCell(4), draws); row.getCell(4).font={size:9,color:{argb:C.green}};
        money(row.getCell(5), intDue);
        money(row.getCell(6), intDue); row.getCell(6).font={size:9,color:{argb:'FF3B82F6'}};
        money(row.getCell(7), 0);
        money(row.getCell(8), 0);
        // Closing balance formula: =Opening + Draw + CapInt - IntPaid - Principal
        money(row.getCell(9), closeBal, `=C${tiRow}+D${tiRow}+F${tiRow}-G${tiRow}-H${tiRow}`);
        row.getCell(9).font={size:9,bold:true,color:{argb:'FF3B82F6'}};
        // Check formula: should be 0
        row.getCell(10).value = {formula:`=I${tiRow}-${closeBal}`, result:0};
        row.getCell(10).numFmt='$#,##0'; row.getCell(10).font={size:8,color:{argb:C.stone}};
        if(b%2===1) setRowFill(row, C.rowAlt);
        row.eachCell(c => setBorder(c));
        tiRow++;
      }

      // Ops rows
      const scdDate = model.general.serviceCommencementDate || addMonths2(tifc,cm).toISOString().slice(0,10);
      if(tSched){
        tSched.interest.forEach((_, i) => {
          const regime = getPhase(i);
          const openBal = i===0 ? (tConstr?.finalBalance||0) : tSched.balance[i-1];
          const intDue = regime==='defer' ? openBal*(tifiaInstObj?.rate||0.041)/ppy2 : tSched.interest[i];
          const capInt = regime==='defer' ? intDue : 0;
          const intPaid = regime==='defer' ? 0 : tSched.interest[i];
          const principal = tSched.principal[i]||0;
          const closeBal = tSched.balance[i];
          const tStart = addMonths2(scdDate, i*tiMpp);
          const tEnd   = addMonths2(scdDate, (i+1)*tiMpp);

          const row = wsTIFIA.getRow(tiRow);
          row.getCell(1).value = `${tStart.toLocaleDateString('en-US',{month:'short',year:'numeric'})} – ${tEnd.toLocaleDateString('en-US',{month:'short',year:'numeric'})}`;
          row.getCell(1).font={size:9};
          const phaseColors = {defer:'FF3B82F6',io:'FFF59E0B',level:'FF16A34A',sculpt:'FFA78BFA',Construction:C.stone};
          row.getCell(2).value = regime; row.getCell(2).font={size:9,color:{argb:phaseColors[regime]||C.stone},bold:true};
          money(row.getCell(3), openBal);
          money(row.getCell(4), 0); // no draws in ops
          money(row.getCell(5), intDue);
          money(row.getCell(6), capInt); if(capInt>0) row.getCell(6).font={size:9,color:{argb:'FF3B82F6'}};
          money(row.getCell(7), intPaid); if(intPaid>0) row.getCell(7).font={size:9,color:{argb:C.amberDark}};
          money(row.getCell(8), principal); if(principal>0) row.getCell(8).font={size:9,color:{argb:C.red}};
          // Closing balance formula
          money(row.getCell(9), closeBal, `=C${tiRow}+D${tiRow}+F${tiRow}-G${tiRow}-H${tiRow}`);
          row.getCell(9).font={size:9,bold:true,color:{argb:closeBal>openBal?'FF3B82F6':'FF16A34A'}};
          // Check
          row.getCell(10).value={formula:`=I${tiRow}-${closeBal}`,result:0};
          row.getCell(10).numFmt='$#,##0'; row.getCell(10).font={size:8,color:{argb:C.stone}};

          if(i%2===1) setRowFill(row, C.rowAlt);
          row.eachCell(c => setBorder(c));
          tiRow++;
        });
      }

      // ════════════════════════════════════════
      // SHEET 6 — OUTPUTS
      // ════════════════════════════════════════
      const wsOut = wb.addWorksheet('Outputs', {views:[{showGridLines:false}]});
      wsOut.columns = [{width:36},{width:22},{width:22}];
      let oRow = 1;
      const O = (label, val, fmt='text') => { oRow = addKV(wsOut, oRow, label, val, fmt); };

      oRow = sectionHdr(wsOut, oRow, '▸  OPTIMIZER RESULT  (last cascade run)');
      O('TIFIA Sized (%)', lastRun.bestPct||0, 'pct');
      O('TIFIA Sized ($)', lastRun.bestTifia||0, 'money');
      O('PAB Sized ($)', lastRun.bestPab||0, 'money');
      O('Equity Sized ($)', 0, 'money'); // will be overwritten with actual
      O('Target Equity IRR', model.optimizer?.cascade?.targetEquityIRR||0.12, 'pct');
      O('Actual Equity IRR', r.equityIRR||0, 'pct');
      // Highlight subsidy
      oRow++;
      const subRow = wsOut.getRow(oRow);
      wsOut.mergeCells(`A${oRow}:B${oRow}`);
      subRow.getCell(1).value = '★  UPFRONT SUBSIDY REQUIRED  ★';
      subRow.getCell(1).font={bold:true,size:14,color:{argb:C.amber}};
      subRow.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:C.medBg}};
      subRow.getCell(1).alignment={horizontal:'center',vertical:'middle'};
      subRow.height=32;
      oRow++;
      const subValRow = wsOut.getRow(oRow++);
      subValRow.getCell(1).value='';
      money(subValRow.getCell(2), lastRun.bestSubsidy||0);
      subValRow.getCell(2).font={bold:true,size:18,color:{argb:C.amber}};
      subValRow.getCell(2).fill={type:'pattern',pattern:'solid',fgColor:{argb:C.amberBg}};
      subValRow.getCell(2).alignment={horizontal:'right'};
      subValRow.height=36;
      oRow++;

      oRow = sectionHdr(wsOut, oRow, '▸  PROJECT METRICS');
      O('Project IRR', r.projectIRR||0, 'pct');
      O('Min Senior DSCR', r.minSeniorDSCR, 'ratio');
      O('Min Total DSCR', r.totalDSCR?Math.min(...r.totalDSCR.filter(v=>v&&isFinite(v))):0, 'ratio');
      O('Min LLCR', r.minLLCR, 'ratio');
      O('TIFIA All-in Rate', r.tifiaAllInRate||0, 'pct');
      O('Total Uses', r.totalUses, 'money');
      O('Total Sources', r.totalSources, 'money');
      O('Funding Gap', r.totalUses - r.totalSources, 'money');
      O('Issuance Costs (total)', r.totalIssuanceCost, 'money');
      O('TIFIA Admin + Monitoring (life)', r.totalTifiaFees, 'money');
      oRow++;

      oRow = sectionHdr(wsOut, oRow, '▸  TIFIA AMORTIZATION CHECKPOINTS');
      const tS = r.debtSchedules?.[model.tifia?.instrumentId||'tifia1'];
      if(tS){
        O('TIFIA Principal', tifiaInstObj?.amount||0, 'money');
        O('TIFIA Capitalised Interest', r.tifiaConstr?.capitalizedInterestTotal||0, 'money');
        O('TIFIA Peak Balance', Math.max(...tS.balance.filter(v=>v!=null)), 'money');
        O('TIFIA Balance at Test Point', tS.balance[49]||0, 'money');
        O('TIFIA Final Balance', tS.balance[tS.balance.length-1]||0, 'money');
        O('50% Test Result', Math.abs((tS.balance[49]||0) - 0.5*(tifiaInstObj?.amount||0)) < 1e5 ? 'PASS ✓' : 'FAIL ✗');
      }

      // ── Write file ──────────────────────────
      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `TollRoad_${(model.general.projectName||'Model').replace(/[^a-z0-9]/gi,'_')}_${new Date().toISOString().slice(0,10)}.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch(e) {
      alert('Export failed: ' + e.message);
    }
    setExporting(false);
  };
  // Debt service vs revenue chart data
  const chartData = (r.periods || []).map((p,i)=>({
    period: p.label,
    Revenue: r.revSched.byPeriod[i],
    'Sr Int': r.seniorInt[i],
    'Sr Pri': r.seniorPri[i],
    'Sub Int': r.subInt[i],
    'Sub Pri': r.subPri[i],
    'ST DS': r.shortDS[i],
  }));
  return <div>
    <div className="flex justify-end mb-3">
      <button onClick={exportXLSX} disabled={exporting}
        className="px-4 py-2 bg-emerald-500/10 border border-emerald-500/50 text-emerald-300 rounded text-xs font-medium hover:bg-emerald-500/20 disabled:opacity-50">
        {exporting ? 'Exporting…' : '⬇ Export All to Excel'}
      </button>
    </div>
    {model.optimizer?.lastAutoCascadeRun?.bestSubsidy != null && (
      <Section title="Project Funding Ask — Upfront Subsidy" subtitle="From the last optimizer run. Government / sponsor capital needed at financial close to close the funding gap after maximum debt and equity sized to target IRR.">
        <div className="bg-gradient-to-r from-amber-500/15 to-amber-500/5 border-2 border-amber-500/50 rounded-lg p-5">
          <div className="text-[11px] uppercase tracking-widest text-amber-400 mb-2">Upfront Subsidy Required</div>
          <div className="text-5xl font-extralight text-amber-300 mb-2">{fmt$(model.optimizer.lastAutoCascadeRun.bestSubsidy)}</div>
          <div className="grid grid-cols-3 gap-6 mt-4 text-xs">
            <div><span className="text-stone-500">TIFIA: </span><span className="text-stone-200">{fmt$(model.optimizer.lastAutoCascadeRun.bestTifia)}</span> ({fmtPct(model.optimizer.lastAutoCascadeRun.bestPct||0,1)})</div>
            <div><span className="text-stone-500">PAB: </span><span className="text-stone-200">{fmt$(model.optimizer.lastAutoCascadeRun.bestPab)}</span></div>
            <div><span className="text-stone-500">Target Equity IRR: </span><span className="text-stone-200">{fmtPct(model.optimizer?.cascade?.targetEquityIRR||0.12,1)}</span></div>
          </div>
        </div>
      </Section>
    )}
    <Section title="Key Metrics">
      <div className="grid grid-cols-4 gap-3 mb-4">
        <Metric label="Project IRR" value={fmtPct(r.projectIRR,2)} accent="amber"/>
        <Metric label="Equity IRR" value={fmtPct(r.equityIRR,2)} accent="amber" sub={`vs target ${fmtPct(model.optimizer?.cascade?.targetEquityIRR||0.12,1)}`}/>
        <Metric label="Min Senior DSCR" value={fmtRatio(minSr)} accent={minSr>=1.30?'green':'red'} sub="floor 1.30x"/>
        <Metric label="Min Total DSCR" value={fmtRatio(minTot)} accent={minTot && minTot>=1.10?'green':'red'} sub="floor 1.10x"/>
      </div>
      <div className="grid grid-cols-4 gap-3 mb-4">
        <Metric label="Min LLCR" value={fmtRatio(r.minLLCR)} accent="amber"/>
        <Metric label="TIFIA All-in Rate" value={fmtPct(r.tifiaAllInRate||0,3)} accent="amber"/>
        <Metric label="Total Uses" value={fmt$(r.totalUses)}/>
        <Metric label="Funding Gap" value={fmt$(gap)} accent={Math.abs(gap)<1e6?'green':'red'}/>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <Metric label="Issuance Costs" value={fmt$(r.totalIssuanceCost)} sub="At FC"/>
        <Metric label="TIFIA Admin+Mon" value={fmt$(r.totalTifiaFees)} sub="Life of loan"/>
        <Metric label="Total Equity Sized" value={fmt$(r.equityTotal)}/>
        <Metric label="Total Debt Sized" value={fmt$(r.debtTotal)}/>
      </div>
    </Section>
    <Section title="Debt Service vs Revenue (Operating Period)">
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#44403c"/>
          <XAxis dataKey="period" tick={{fontSize:10, fill:'#a8a29e'}}/>
          <YAxis tick={{fontSize:10, fill:'#a8a29e'}} tickFormatter={v=>`$${(v/1e6).toFixed(0)}M`}/>
          <Tooltip contentStyle={{background:'#1c1917',border:'1px solid #44403c'}}/>
          <Legend wrapperStyle={{fontSize:11}}/>
          <Bar dataKey="Sr Int" stackId="ds" fill="#f59e0b"/>
          <Bar dataKey="Sr Pri" stackId="ds" fill="#fbbf24"/>
          <Bar dataKey="Sub Int" stackId="ds" fill="#a78bfa"/>
          <Bar dataKey="Sub Pri" stackId="ds" fill="#c4b5fd"/>
          <Bar dataKey="ST DS" stackId="ds" fill="#fb7185"/>
          <Line type="monotone" dataKey="Revenue" stroke="#10b981" strokeWidth={2} dot={false}/>
        </ComposedChart>
      </ResponsiveContainer>
    </Section>

    <Section title="Cash Inflow vs Outflow (Operating Period)"
      subtitle="Inflow = toll revenue (line). Outflow = opex + debt service + TIFIA fees (stacked, all positive).">
      <ResponsiveContainer width="100%" height={360}>
        <ComposedChart data={(r.periods||[]).map((p,i)=>({
          period: p.label,
          Opex: r.opexSched.byPeriod[i],
          'TIFIA Fees': (r.tifiaFeesPerPeriod||[])[i] || 0,
          'Sr Int': r.seniorInt[i],
          'Sr Pri': r.seniorPri[i],
          'Sub Int': r.subInt[i],
          'Sub Pri': r.subPri[i],
          'ST DS': r.shortDS[i],
          Revenue: r.revSched.byPeriod[i],
        }))}>
          <CartesianGrid strokeDasharray="3 3" stroke="#44403c"/>
          <XAxis dataKey="period" tick={{fontSize:10, fill:'#a8a29e'}}/>
          <YAxis tick={{fontSize:10, fill:'#a8a29e'}} tickFormatter={v=>`$${(v/1e6).toFixed(0)}M`}/>
          <Tooltip contentStyle={{background:'#1c1917',border:'1px solid #44403c'}} formatter={(v)=>`$${(v/1e6).toFixed(2)}M`}/>
          <Legend wrapperStyle={{fontSize:11}}/>
          <Bar dataKey="Opex" stackId="out" fill="#64748b"/>
          <Bar dataKey="TIFIA Fees" stackId="out" fill="#84cc16"/>
          <Bar dataKey="Sr Int" stackId="out" fill="#f59e0b"/>
          <Bar dataKey="Sr Pri" stackId="out" fill="#fbbf24"/>
          <Bar dataKey="Sub Int" stackId="out" fill="#a78bfa"/>
          <Bar dataKey="Sub Pri" stackId="out" fill="#c4b5fd"/>
          <Bar dataKey="ST DS" stackId="out" fill="#fb7185"/>
          <Line type="monotone" dataKey="Revenue" stroke="#10b981" strokeWidth={3} dot={false} name="Revenue (Inflow)"/>
        </ComposedChart>
      </ResponsiveContainer>
      <div className="text-[10px] text-stone-500 mt-2">Where the green Revenue line sits ABOVE the stacked bars = positive equity cashflow (distributable). Where it sits below = lockup or DSRA draw.</div>
    </Section>
  </div>;
}

// ---------- CASHFLOW ----------
function CashflowTab({model, results}){
  if(!results) return <div className="p-8 text-center text-stone-500">Loading…</div>;
  const r = results;
  const periods = r.periods;
  const ppy = model.general.periodsPerYear || 2;
  const instruments = model.financing.instruments;

  // Reserve movements come straight from the engine's controlAccts
  const cacct = r.controlAccts || {};
  const dsraAcct = cacct.dsra || {deposit:[],release:[],balance:[]};
  const omAcct = cacct.om || {deposit:[],release:[],balance:[]};
  const mmrAcct = cacct.mmrAcct || {deposit:[],release:[],balance:[]};
  const rampAcct = cacct.rampAcct || {deposit:[],release:[],balance:[]};
  const hasReserves = (dsraAcct.balance||[]).some(v=>v>0) || (mmrAcct.balance||[]).some(v=>v>0) || (rampAcct.balance||[]).some(v=>v>0);

  // Cumulative equity CF
  let cumEqCF = 0;
  const cumEquityCF = (r.rawEquityCF||r.equityCF||[]).map(v => { cumEqCF += (v||0); return cumEqCF; });

  // Waterfall header row builder
  const SectionRow = ({label, indent=0}) => (
    <tr className="bg-stone-900/80">
      <td colSpan={periods.length + 1} className="py-1 px-3">
        <span className="text-[10px] uppercase tracking-widest text-amber-400 font-medium" style={{paddingLeft:`${indent*12}px`}}>{label}</span>
      </td>
    </tr>
  );
  const WFRow = ({label, data, positive, negative, bold, sub, ratio, indent=0, separator=false, accent}) => {
    const fmtV = (v) => {
      if(v==null || (!isFinite(v))) return <span className="text-stone-700">—</span>;
      if(ratio) return <span className={bold?'font-medium':''}>{v.toFixed(2)}x</span>;
      const abs = Math.abs(v);
      const str = abs >= 1e6 ? `$${(abs/1e6).toFixed(2)}M` : abs >= 1e3 ? `$${(abs/1e3).toFixed(0)}k` : `$${abs.toFixed(0)}`;
      return <span className={bold?'font-medium':''}>{v < 0 ? `(${str})` : str}</span>;
    };
    const color = accent ? `text-${accent}-300` : positive ? 'text-emerald-300' : negative ? 'text-rose-300' : bold ? 'text-stone-100' : 'text-stone-400';
    return (
      <tr className={`hover:bg-stone-900/30 ${separator?'border-t border-stone-700/60':''}`}>
        <td className={`sticky left-0 bg-stone-950 py-[3px] px-3 text-[11px] ${bold?'text-stone-200 font-medium':'text-stone-400'} min-w-[260px]`}
          style={{paddingLeft:`${8+indent*12}px`}}>
          {label}{sub && <span className="text-stone-600 text-[9px] ml-1">{sub}</span>}
        </td>
        {data.map((v,i) => (
          <td key={i} className={`text-right py-[3px] px-2 text-[11px] ${color} font-mono`}>{fmtV(v)}</td>
        ))}
      </tr>
    );
  };

  // Build per-instrument DS rows (for each non-grant, non-equity instrument)
  const activeInsts = instruments.filter(inst =>
    !['Grant','Equity','Paygo'].includes(inst.seniority) &&
    (r.debtSchedules?.[inst.id]?.principal?.some(v=>v>0) || r.debtSchedules?.[inst.id]?.interest?.some(v=>v>0))
  );

  // Compute running coverage after each seniority tranche
  const srDSRunning = periods.map((_,i) => {
    const srDS = (r.seniorInt[i]||0) + (r.seniorPri[i]||0);
    const cfads = (r.cfadsForDscr||r.cfadsByPeriod||[])[i]||0;
    return srDS > 0 ? cfads / srDS : null;
  });

  return <div>
    <Section title={`Full Cashflow Waterfall — ${ppy===2?'Semi-Annual':'Annual'}`}
      subtitle={`${periods.length} periods · All amounts in nominal $ · (brackets) = outflows`}>
      <div className="overflow-x-auto border border-stone-700/60 rounded">
        <table className="w-full text-xs" style={{minWidth:`${periods.length*90+280}px`}}>
          <thead className="bg-stone-900 sticky top-0 z-10"><tr>
            <th className="sticky left-0 bg-stone-900 text-left py-2 px-3 text-[10px] text-stone-400 uppercase tracking-wider min-w-[260px] z-20">Line Item</th>
            {periods.map((p,i)=>(
              <th key={i} className="text-right py-2 px-2 text-[10px] text-stone-400 font-mono whitespace-nowrap">
                {p.label}
              </th>
            ))}
          </tr></thead>
          <tbody>
            {/* ── REVENUE & OPEX ── */}
            <SectionRow label="Revenue & Costs"/>
            <WFRow label="Toll Revenue" data={r.revSched.byPeriod} positive bold/>
            {r.apMode && (r.apStream||[]).some(v=>v>0) && (
              <WFRow label="Availability Payment" data={r.apStream||[]} positive bold accent="emerald"/>
            )}
            {(model.opex?.items||[]).map(it => (
              <WFRow key={it.id} label={`  ${it.label||it.id}`} data={r.opexSched?.byItem?.[it.id]?.map(v=>-v)||Array(periods.length).fill(0)} negative indent={1}/>
            ))}
            <WFRow label="CFADS (Gross)" data={r.cfadsByPeriod} bold separator accent="amber"/>

            {/* ── TIFIA FEES ── */}
            {(r.tifiaFeesPerPeriod||[]).some(v=>v>0) && <>
              <SectionRow label="TIFIA Fees"/>
              <WFRow label="Admin Fee" data={(r.tifiaAdminPerPeriod||[]).map(v=>-v)} negative indent={1}/>
              <WFRow label="Monitoring Fee" data={(r.tifiaMonitoringPerPeriod||[]).map(v=>-v)} negative indent={1}/>
              <WFRow label="CFADS for DSCR" data={r.cfadsForDscr||r.cfadsByPeriod} bold separator accent="amber"/>
            </>}

            {/* ── DEBT SERVICE PER INSTRUMENT ── */}
            <SectionRow label="Debt Service Waterfall"/>
            {activeInsts.map(inst => {
              const sched = r.debtSchedules?.[inst.id];
              if(!sched) return null;
              const totalDS = periods.map((_,i) => -((sched.interest[i]||0)+(sched.principal[i]||0)));
              return <React.Fragment key={inst.id}>
                <tr className="bg-stone-900/30"><td colSpan={periods.length+1} className="sticky left-0 py-1 px-3 text-[10px] text-stone-300 bg-stone-950">{inst.type} ({inst.id}) — {inst.seniority}</td></tr>
                <WFRow label="Interest" data={sched.interest.map(v=>-v)} negative indent={1}/>
                <WFRow label="Principal" data={sched.principal.map(v=>-v)} negative indent={1}/>
                <WFRow label="Total DS" data={totalDS} negative bold indent={1}/>
                <WFRow label="Outstanding Balance" data={sched.balance} indent={1} sub="(end of period)"/>
              </React.Fragment>;
            })}

            {/* ── COVERAGE RATIOS ── */}
            <SectionRow label="Coverage Ratios"/>
            <WFRow label="Senior DSCR" data={r.seniorDSCR} ratio bold accent="amber" separator/>
            <WFRow label="Total DSCR (incl. sub debt)" data={r.totalDSCR} ratio bold accent="amber"/>
            {r.llcr && <WFRow label="LLCR" data={r.llcr} ratio accent="amber"/>}

            {/* ── RESERVE ACCOUNTS ── */}
            {hasReserves && <>
              <SectionRow label="Reserve Accounts"/>
              {cacct.dsraByInst && Object.keys(cacct.dsraByInst).length > 0
                ? Object.entries(cacct.dsraByInst).map(([id, acct]) => (
                  <React.Fragment key={id}>
                    <tr className="bg-stone-900/20"><td colSpan={periods.length+1} className="sticky left-0 py-1 px-3 text-[10px] text-stone-400 bg-stone-950" style={{paddingLeft:'20px'}}>DSRA — {acct.label} ({id})</td></tr>
                    <WFRow label={`Deposit ${cacct.dsraMode==='initial'?'(initial @ SC)':'(from cash)'}`} data={(acct.deposit||[]).map(v=>-v)} negative indent={2}/>
                    <WFRow label="Release ↑ (lifts coverage)" data={acct.release||[]} positive indent={2} accent="emerald"/>
                    <WFRow label="Balance" data={acct.balance||[]} indent={2} bold/>
                  </React.Fragment>
                ))
                : ((dsraAcct.balance||[]).some(v=>v>0) && <>
                    <WFRow label={`DSRA Deposit ${cacct.dsraMode==='initial'?'(initial @ SC)':'(from cash)'}`} data={(dsraAcct.deposit||[]).map(v=>-v)} negative indent={1}/>
                    <WFRow label="DSRA Release ↑ (lifts coverage)" data={dsraAcct.release||[]} positive indent={1} accent="emerald"/>
                    <WFRow label="DSRA Balance" data={dsraAcct.balance||[]} indent={1} bold/>
                  </>)
              }
              {(dsraAcct.balance||[]).some(v=>v>0) && Object.keys(cacct.dsraByInst||{}).length > 1 && (
                <WFRow label="DSRA Total Balance (all debts)" data={dsraAcct.balance||[]} indent={1} bold accent="amber"/>
              )}
              {(omAcct.balance||[]).some(v=>v>0) && <>
                <WFRow label={`O&M Reserve Deposit ${cacct.omMode==='initial'?'(initial)':'(from cash)'}`} data={(omAcct.deposit||[]).map(v=>-v)} negative indent={1}/>
                <WFRow label="O&M Reserve Release" data={omAcct.release||[]} positive indent={1}/>
                <WFRow label="O&M Reserve Balance" data={omAcct.balance||[]} indent={1} bold/>
              </>}
              {(mmrAcct.balance||[]).some(v=>v>0) && <>
                <WFRow label="MMR Deposit (smoothed, from cash)" data={(mmrAcct.deposit||[]).map(v=>-v)} negative indent={1}/>
                <WFRow label="MM Event Cost (paid from reserve)" data={(cacct.mmEventCost||[]).map(v=>-v)} negative indent={1} accent="rose"/>
                <WFRow label="MMR Release ↑ (funds event)" data={mmrAcct.release||[]} positive indent={1} accent="emerald"/>
                <WFRow label="MMR Balance" data={mmrAcct.balance||[]} indent={1} bold/>
              </>}
              {(rampAcct.balance||[]).some(v=>v>0) && <>
                <WFRow label="Ramp-up Reserve Release" data={rampAcct.release||[]} positive indent={1} accent="emerald"/>
                <WFRow label="Ramp-up Reserve Balance" data={rampAcct.balance||[]} indent={1} bold/>
              </>}
            </>}

            {/* ── EQUITY DISTRIBUTION ── */}
            <SectionRow label="Equity Distribution"/>
            <WFRow label="Distributable CF (pre-lockup)" data={(r.rawEquityCF||r.equityCF||[])} positive bold separator accent="amber"/>
            {(r.lockup||[]).some(v=>v) && (
              <WFRow label="Lockup Amount (escrowed)" data={(r.lockup||[]).map((lk,i)=>lk ? -(((r.rawEquityCF||r.equityCF||[])[i])||0) : 0)} negative indent={1}/>
            )}
            <WFRow label="Equity CF (distributed)" data={r.equityCF||r.rawEquityCF||[]} positive bold/>
            <WFRow label="Cumulative Equity CF" data={cumEquityCF} positive separator sub="(running total)"/>
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-stone-500 mt-2">
        Brackets = outflows. DSRA funded at FC from bond proceeds — initial balance does not appear as periodic deposit.
        Semi-annual periods; dates shown are period end labels.
        {(r.idcByInst?.pab1?.escrow||0) > 0 && ` PAB IDC: Gross $${(r.idcByInst.pab1.gross/1e6).toFixed(1)}M − Escrow earnings $${(r.idcByInst.pab1.escrow/1e6).toFixed(1)}M = Net IDC $${(r.idcByInst.pab1.net/1e6).toFixed(1)}M.`}
      </div>
    </Section>
  </div>;
}

// ---------- SOURCES & USES ----------
function SourcesUsesTab({model, results}){
  if(!results) return <div className="p-8 text-center text-stone-500">Loading…</div>;
  const r = results;
  const issuance = r.issuanceCostsByID || {};
  const cm = model.general.constructionMonths;
  const drawsByInst = r.drawsByInst || {};
  const capexMonthly = r.capexSched?.monthly || [];
  const instruments = model.financing.instruments;

  // Build monthly draw chart data — aggregate into semi-annual buckets for readability
  const ppy = model.general.periodsPerYear;
  const monthsPerPeriod = 12 / ppy;
  const numConstrPeriods = Math.ceil(cm / monthsPerPeriod);
  const constrChartData = Array.from({length: numConstrPeriods}, (_, pi) => {
    const mStart = Math.round(pi * monthsPerPeriod);
    const mEnd = Math.min(cm, Math.round((pi + 1) * monthsPerPeriod));
    const row = {period: `M${mStart+1}–${mEnd}`, capex: 0, Paygo: 0};
    for(let m = mStart; m < mEnd; m++){
      row.capex += capexMonthly[m] || 0;
      row.Paygo += (r.paygoSched?.monthly?.[m] || 0);
    }
    instruments.forEach(inst => {
      const draws = drawsByInst[inst.id] || [];
      let d = 0; for(let m = mStart; m < mEnd; m++) d += draws[m] || 0;
      if(d > 0) row[inst.id] = d;
    });
    return row;
  });

  const instColors = {'fg1':'#10b981','sg1':'#34d399','eq1':'#f59e0b','ran1':'#fb7185','pab1':'#60a5fa','tifia1':'#a78bfa'};
  const activeInsts = instruments.filter(inst => constrChartData.some(d => d[inst.id] > 0));

  return <div>
    <Section title="Sources of Funds">
      <table className="w-full text-sm">
        <thead><tr><TH>Instrument</TH><TH>Type</TH><TH>Seniority</TH><TH className="text-right">Amount</TH><TH className="text-right">% of Sources</TH></tr></thead>
        <tbody>
          {instruments.map(i=>(
            <tr key={i.id} className="hover:bg-stone-900/40">
              <TD className="text-stone-300">{i.id}</TD>
              <TD className="text-stone-400">{i.type}</TD>
              <TD className="text-stone-400">{i.seniority}</TD>
              <TD className="text-right text-amber-300">{fmt$(i.amount)}</TD>
              <TD className="text-right text-stone-400">{fmtPct(i.amount/Math.max(1,r.totalSources),1)}</TD>
            </tr>
          ))}
          <tr className="bg-stone-900/60 font-medium">
            <TD className="text-stone-100" colSpan={3}>Total Sources</TD>
            <TD className="text-right text-emerald-300">{fmt$(r.totalSources)}</TD>
            <TD></TD>
          </tr>
        </tbody>
      </table>
    </Section>

    <Section title="Construction Period — Periodic Draws vs Capex Uses"
      subtitle={`${cm}-month construction, shown in ${monthsPerPeriod.toFixed(0)}-month buckets. Stacked bars = instrument draws (sources). Line = capex spend (uses).`}>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={constrChartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#44403c"/>
          <XAxis dataKey="period" tick={{fontSize:10, fill:'#a8a29e'}}/>
          <YAxis tick={{fontSize:10, fill:'#a8a29e'}} tickFormatter={v=>`$${(v/1e6).toFixed(0)}M`}/>
          <Tooltip contentStyle={{background:'#1c1917',border:'1px solid #44403c'}} formatter={v=>`$${(v/1e6).toFixed(2)}M`}/>
          <Legend wrapperStyle={{fontSize:11}}/>
          {activeInsts.map(inst => (
            <Bar key={inst.id} dataKey={inst.id} name={inst.type} stackId="draws"
              fill={instColors[inst.id]||'#78716c'}/>
          ))}
          {constrChartData.some(d=>d.Paygo>0) && <Bar dataKey="Paygo" name="Paygo / Availability" stackId="draws" fill="#2dd4bf"/>}
          <Line type="monotone" dataKey="capex" name="Capex Uses" stroke="#f97316" strokeWidth={2} dot={false}/>
        </ComposedChart>
      </ResponsiveContainer>
      <div className="overflow-x-auto mt-4 border border-stone-700/60 rounded">
        <table className="w-full text-xs">
          <thead className="bg-stone-900/80"><tr>
            <TH className="sticky left-0 bg-stone-900 min-w-[160px]">Instrument</TH>
            {constrChartData.map((d,i)=><TH key={i} className="text-right">{d.period}</TH>)}
            <TH className="text-right">Total</TH>
          </tr></thead>
          <tbody>
            {activeInsts.map(inst=>(
              <tr key={inst.id} className="hover:bg-stone-900/40">
                <TD className="sticky left-0 bg-stone-950 text-stone-300">{inst.type}</TD>
                {constrChartData.map((d,i)=><TD key={i} className="text-right text-stone-400">{d[inst.id]?fmt$(d[inst.id]):'—'}</TD>)}
                <TD className="text-right text-amber-300">{fmt$(inst.amount)}</TD>
              </tr>
            ))}
            {constrChartData.some(d=>d.Paygo>0) && (
              <tr className="hover:bg-stone-900/40">
                <TD className="sticky left-0 bg-stone-950 text-teal-300">Paygo / Availability</TD>
                {constrChartData.map((d,i)=><TD key={i} className="text-right text-teal-400">{d.Paygo?fmt$(d.Paygo):'—'}</TD>)}
                <TD className="text-right text-teal-300">{fmt$(r.paygoSched?.total||0)}</TD>
              </tr>
            )}
            <tr className="bg-stone-900/40 font-medium">
              <TD className="sticky left-0 bg-stone-900 text-stone-200">Capex Uses</TD>
              {constrChartData.map((d,i)=><TD key={i} className="text-right text-orange-300">{fmt$(d.capex)}</TD>)}
              <TD className="text-right text-orange-300">{fmt$(r.capexSched.totalNominal)}</TD>
            </tr>
          </tbody>
        </table>
      </div>
    </Section>

    <Section title="Uses of Funds">
      <table className="w-full text-sm">
        <thead><tr><TH>Category</TH><TH className="text-right">Amount</TH><TH className="text-right">% of Uses</TH></tr></thead>
        <tbody>
          <tr><TD>Nominal Capex (total construction cost incl. inflation)</TD><TD className="text-right text-stone-300">{fmt$(r.capexSched.totalNominal)}</TD><TD className="text-right text-stone-400">{fmtPct(r.capexSched.totalNominal/Math.max(1,r.totalUses),1)}</TD></tr>
          <tr><TD>Non-TIFIA IDC</TD><TD className="text-right text-stone-300">{fmt$(r.nonTIFIAIDC)}</TD><TD className="text-right text-stone-400">{fmtPct(r.nonTIFIAIDC/Math.max(1,r.totalUses),1)}</TD></tr>
          <tr><TD>TIFIA Capitalized Interest</TD><TD className="text-right text-stone-300">{fmt$(r.tifiaConstr?.capitalizedInterestTotal||0)}</TD><TD className="text-right text-stone-400">{fmtPct((r.tifiaConstr?.capitalizedInterestTotal||0)/Math.max(1,r.totalUses),1)}</TD></tr>
          <tr><TD>Financing Fees (% of debt)</TD><TD className="text-right text-stone-300">{fmt$(r.financingFees)}</TD><TD className="text-right text-stone-400">{fmtPct(r.financingFees/Math.max(1,r.totalUses),1)}</TD></tr>
          <tr><TD>Issuance Costs (escalated)</TD><TD className="text-right text-stone-300">{fmt$(r.totalIssuanceCost)}</TD><TD className="text-right text-stone-400">{fmtPct(r.totalIssuanceCost/Math.max(1,r.totalUses),1)}</TD></tr>
          <tr className="bg-stone-900/60 font-medium"><TD className="text-stone-100">Total Uses</TD><TD className="text-right text-amber-300">{fmt$(r.totalUses)}</TD><TD></TD></tr>
          <tr className="bg-stone-900/40"><TD className="text-stone-300">Funding Gap (Uses − Sources)</TD><TD className={`text-right ${Math.abs(r.totalUses - r.totalSources) < 1e6 ? 'text-emerald-300' : 'text-rose-300'}`}>{fmt$(r.totalUses - r.totalSources)}</TD><TD></TD></tr>
        </tbody>
      </table>
    </Section>

    <Section title="Issuance Costs Detail">
      <table className="w-full text-sm">
        <thead><tr><TH>Instrument</TH><TH className="text-right">Base $</TH><TH className="text-right">Esc %/yr</TH><TH className="text-right">Escalated to FC</TH></tr></thead>
        <tbody>
          {instruments.map(i => i.issuanceCost > 0 && (
            <tr key={i.id}>
              <TD className="text-stone-300">{i.id} — {i.type}</TD>
              <TD className="text-right text-stone-400">{fmt$(i.issuanceCost)}</TD>
              <TD className="text-right text-stone-400">{fmtPct(i.issuanceCostEscalation||0,2)}</TD>
              <TD className="text-right text-amber-300">{fmt$(issuance[i.id]||0)}</TD>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  </div>;
}

// ---------- TIFIA SCHEDULE ----------
function TifiaScheduleTab({model, results}){
  if(!results) return <div className="p-8 text-center text-stone-500">Loading…</div>;
  const r = results;
  const tifiaInstId = model.tifia?.instrumentId || 'tifia1';
  const tifiaInst = model.financing.instruments.find(i=>i.id===tifiaInstId);
  if(!tifiaInst) return <div className="p-8 text-center text-stone-500">No TIFIA instrument found.</div>;

  const sched = r.debtSchedules?.[tifiaInstId];
  const constr = r.tifiaConstr;
  if(!sched || !constr) return <div className="p-8 text-center text-stone-500">No TIFIA schedule data.</div>;

  const cm = model.general.constructionMonths;
  const ppy = model.general.periodsPerYear;
  const monthsPerPeriod = 12 / ppy;
  const fc = model.general.financialCloseDate || '2026-07-01';
  const phases = tifiaInst.phases || [];

  // Date helpers
  const addMonths = (dateStr, n) => {
    const d = new Date(dateStr);
    d.setMonth(d.getMonth() + Math.round(n));
    return d.toLocaleDateString('en-US',{month:'short',year:'numeric'});
  };

  // Figure out regime for each ops period
  const getRegime = (periodIdx) => {
    for(const ph of phases){
      if(periodIdx < ph.endPeriod) return ph.regime;
    }
    return 'level';
  };

  // Build unified schedule rows
  const rows = [];

  // CONSTRUCTION PHASE — aggregate monthly into semi-annual periods
  const numConstrPeriods = Math.ceil(cm / monthsPerPeriod);
  for(let pi = 0; pi < numConstrPeriods; pi++){
    const mStart = Math.round(pi * monthsPerPeriod);
    const mEnd = Math.min(cm, Math.round((pi+1) * monthsPerPeriod));
    const dateStart = addMonths(fc, mStart);
    const dateEnd = addMonths(fc, mEnd);
    const openBal = mStart === 0 ? 0 : (constr.monthlyBalance[mStart-1] || 0);
    let draws = 0, intDue = 0;
    for(let m = mStart; m < mEnd; m++){
      draws += constr.monthlyDraws?.[m] || 0;
      intDue += constr.monthlyInterest?.[m] || 0;
    }
    const closeBal = constr.monthlyBalance[mEnd - 1] || 0;
    // All construction interest capitalizes
    rows.push({
      date: `${dateStart} – ${dateEnd}`, phase: 'Construction',
      openBal, draws, intDue, capInt: intDue, intPaid: 0, principal: 0, closeBal,
      isConstr: true,
    });
  }

  // OPERATIONS PHASE
  const scd = model.general.serviceCommencementDate || addMonths(fc, cm);
  for(let i = 0; i < sched.interest.length; i++){
    const tStart = addMonths(scd, i * monthsPerPeriod);
    const tEnd = addMonths(scd, (i+1) * monthsPerPeriod);
    const regime = getRegime(i);
    const openBal = i === 0 ? constr.finalBalance : sched.balance[i-1];
    const intDue = regime === 'defer' ? openBal * tifiaInst.rate / ppy : sched.interest[i];
    const capInt = regime === 'defer' ? intDue : 0;
    const intPaid = regime === 'defer' ? 0 : sched.interest[i];
    const principal = sched.principal[i] || 0;
    const closeBal = sched.balance[i];
    rows.push({
      date: `${tStart} – ${tEnd}`, phase: regime,
      openBal, draws: 0, intDue, capInt, intPaid, principal, closeBal,
      isConstr: false,
    });
  }

  const phaseColor = {Construction:'text-stone-400', defer:'text-blue-400', io:'text-yellow-400', level:'text-emerald-400', sculpt:'text-purple-400'};

  return <div>
    <Section title="TIFIA Amortization Schedule"
      subtitle={`${(tifiaInst.rate*100).toFixed(3)}% p.a. · ${tifiaInst.tenorYears}yr tenor · ${tifiaInst.dayCount} · FC: ${fc}`}>
      <div className="grid grid-cols-4 gap-3 mb-4">
        <Metric label="TIFIA Principal" value={fmt$(tifiaInst.amount)} accent="amber"/>
        <Metric label="Capitalized Interest" value={fmt$(constr.capitalizedInterestTotal)} sub="construction phase"/>
        <Metric label="Peak Balance" value={fmt$(Math.max(...sched.balance.filter(v=>v!=null)))} sub="at end of CapI/IO"/>
        <Metric label="Final Balance" value={fmt$(sched.balance[sched.balance.length-1])} accent={sched.balance[sched.balance.length-1]<1e5?'green':'red'}/>
      </div>
      <div className="overflow-x-auto border border-stone-700/60 rounded">
        <table className="w-full text-xs">
          <thead className="bg-stone-900/80 sticky top-0"><tr>
            <TH className="sticky left-0 bg-stone-900 min-w-[200px]">Period</TH>
            <TH className="text-center min-w-[90px]">Phase</TH>
            <TH className="text-right">Opening Balance</TH>
            <TH className="text-right">Drawdown</TH>
            <TH className="text-right">Interest Due</TH>
            <TH className="text-right">Capitalised Int</TH>
            <TH className="text-right">Interest Paid</TH>
            <TH className="text-right">Principal Repaid</TH>
            <TH className="text-right">Closing Balance</TH>
          </tr></thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={`hover:bg-stone-900/40 ${row.isConstr?'bg-stone-900/20':''}`}>
                <TD className="sticky left-0 bg-stone-950 text-stone-400 font-mono text-[10px]">{row.date}</TD>
                <TD className={`text-center font-medium ${phaseColor[row.phase]||'text-stone-400'}`}>{row.phase}</TD>
                <TD className="text-right text-stone-300">{fmt$(row.openBal)}</TD>
                <TD className="text-right text-emerald-400">{row.draws > 0 ? fmt$(row.draws) : '—'}</TD>
                <TD className="text-right text-stone-300">{row.intDue > 0 ? fmt$(row.intDue) : '—'}</TD>
                <TD className="text-right text-blue-300">{row.capInt > 0 ? fmt$(row.capInt) : '—'}</TD>
                <TD className="text-right text-amber-300">{row.intPaid > 0 ? fmt$(row.intPaid) : '—'}</TD>
                <TD className="text-right text-rose-300">{row.principal > 0 ? fmt$(row.principal) : '—'}</TD>
                <TD className={`text-right font-medium ${row.closeBal > row.openBal ? 'text-blue-300' : row.closeBal < row.openBal ? 'text-emerald-300' : 'text-stone-300'}`}>{fmt$(row.closeBal)}</TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-stone-500 mt-2">
        Construction: interest accrues monthly, capitalises every 6 months. 
        Defer: interest capitalises. IO: interest paid, no principal. 
        Level/Sculpt: interest + principal payments. Blue closing balance = growing, green = amortising.
      </div>
    </Section>
  </div>;
}

// ---------- CHAT ----------
function ChatTab({model, setModel, results}){
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const send = async () => {
    if(!input.trim() || loading) return;
    const userMsg = {role:'user', content: input};
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{'Content-Type':'application/json', 'anthropic-version':'2023-06-01', 'anthropic-dangerous-direct-browser-access':'true'},
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          system: `You are a project finance assistant for a US toll road model. Current state: TIFIA = $${(model.financing.instruments.find(i=>i.type==='TIFIA Loan')?.amount/1e6).toFixed(1)}M, Min Sr DSCR = ${results?.minSeniorDSCR?.toFixed(2)}x.`,
          messages: newMessages,
        })
      });
      const data = await resp.json();
      const text = data.content?.[0]?.text || data.error?.message || 'No response';
      setMessages([...newMessages, {role:'assistant', content: text}]);
    } catch(e) {
      setMessages([...newMessages, {role:'assistant', content: 'Error: ' + e.message + ' (requires API proxy backend — does not work from static GitHub Pages)'}]);
    }
    setLoading(false);
  };
  return <div>
    <Section title="AI Assistant" subtitle="Ask questions about the model. Requires Anthropic API backend.">
      <div className="bg-stone-900/40 border border-stone-700/60 rounded p-3 mb-3 h-96 overflow-y-auto">
        {messages.length === 0 && <div className="text-stone-500 text-sm">No messages yet. Ask anything about the model.</div>}
        {messages.map((m,i)=>(
          <div key={i} className={`mb-3 ${m.role==='user'?'text-amber-200':'text-stone-300'}`}>
            <div className="text-[10px] uppercase tracking-wider text-stone-500 mb-1">{m.role}</div>
            <div className="text-sm whitespace-pre-wrap">{m.content}</div>
          </div>
        ))}
        {loading && <div className="text-stone-500 text-sm italic">Thinking…</div>}
      </div>
      <div className="flex gap-2">
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&send()}
          placeholder="Ask about the model…"
          className="flex-1 bg-stone-900 border border-stone-700 rounded px-3 py-2 text-sm text-stone-100"/>
        <button onClick={send} disabled={loading} className="px-4 py-2 bg-amber-500 text-stone-900 rounded text-sm font-medium hover:bg-amber-400 disabled:opacity-50">Send</button>
      </div>
    </Section>
  </div>;
}

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
  const vfm = useMemo(()=>{
    try { return buildVfMAnalysis(model, results); }
    catch(e){ console.error('VfM analysis error:', e); return null; }
  }, [model, results]);
  if(!vfm) return <div className="p-8 text-stone-400">VfM analysis unavailable — check that the model has run. <button onClick={()=>{localStorage.clear();window.location.reload();}} className="ml-2 px-3 py-1 bg-amber-500 text-stone-900 rounded text-sm">Reset</button></div>;
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
    { owner:'Public',  Construction: vfm.risks.construction.public/1e6,  Operations: vfm.risks.operations.annualPublic/1e6 },
    { owner:'Private', Construction: vfm.risks.construction.private/1e6, Operations: vfm.risks.operations.annualPrivate/1e6 },
  ];

  return <div>
    <Section title="PSC vs P3 Parameters" subtitle="The Public Sector Comparator (PSC) is what traditional delivery would cost. Both NPVs are taken at the PSC discount rate from the public sector's perspective.">
      <div className="grid grid-cols-3 gap-4 mb-4">
        <Field label="PSC Discount Rate"><NumInput value={v.pscDiscountRate} onChange={x=>setV({pscDiscountRate:x})} step={0.005} suffix="%"/></Field>
        <Field label="PSC Cost Premium" hint="Private-sector efficiency gap PSC misses"><NumInput value={v.pscCostPremium} onChange={x=>setV({pscCostPremium:x})} step={0.01} suffix="%"/></Field>
        <Field label="Competitive Neutrality %" hint="PSC tax/regulatory advantage adjustment"><NumInput value={v.competitiveNeutralityPct} onChange={x=>setV({competitiveNeutralityPct:x})} step={0.005} suffix="%"/></Field>
      </div>
      <div className="flex items-center gap-3 bg-stone-900/40 border border-stone-700/60 rounded p-3">
        <button onClick={()=>setV({pscUseLeverage: v.pscUseLeverage === false})}
          className={`w-12 h-6 rounded-full transition-colors ${v.pscUseLeverage !== false ? 'bg-amber-500' : 'bg-stone-700'} relative`}>
          <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${v.pscUseLeverage !== false ? 'translate-x-7' : 'translate-x-1'}`}/>
        </button>
        <div>
          <div className="text-sm text-stone-200">{v.pscUseLeverage !== false ? 'Leveraged PSC (debt-financed)' : 'Unleveraged PSC (100% public cash)'}</div>
          <div className="text-[10px] text-stone-500">
            {v.pscUseLeverage !== false
              ? `Public delivery raises the same debt the project supports (${fmt$(vfm.totalDebtRaised)}, ${fmtPct(vfm.debtCoverFrac,0)} of capex); public funds only the residual gap upfront and services debt from toll revenue.`
              : 'Public funds 100% of capex from cash at financial close — no leverage.'}
          </div>
        </div>
      </div>
    </Section>

    {!vfm.optimizerRun && (
      <div className="bg-amber-500/10 border-2 border-amber-500/50 rounded-lg p-4 mb-4">
        <div className="text-sm font-medium text-amber-300 mb-1">⚠ Run the Optimizer first</div>
        <div className="text-xs text-stone-400">The P3 government cost is driven by the optimizer's solved government support (upfront subsidy or availability payment). Go to the <span className="text-amber-300">Optimizer</span> tab and click <span className="text-amber-300">Run Cascade &amp; Apply</span>. Until then, the P3 side uses $0 support and the VfM comparison is incomplete.</div>
      </div>
    )}

    <Section title="P3 Delivery Mode" subtitle="Government support is taken directly from the optimizer result — no separate input. Switch mode in the General tab (Upfront Subsidy vs Availability Payment).">
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-stone-900/40 border border-stone-700/60 rounded p-3">
          <div className="text-[10px] uppercase tracking-wider text-stone-500 mb-1">Active Mode (from General tab)</div>
          <div className="text-lg font-medium text-stone-100">{vfm.apModeActive ? 'Availability Payment' : 'Toll Concession + Upfront Subsidy'}</div>
        </div>
        <div className="bg-stone-900/40 border border-stone-700/60 rounded p-3">
          <div className="text-[10px] uppercase tracking-wider text-stone-500 mb-1">{vfm.apModeActive ? 'Solved AP (base/period)' : 'Solved Upfront Subsidy'}</div>
          <div className="text-lg font-medium text-emerald-300">{vfm.apModeActive ? fmt$(vfm.solvedAPBase) : fmt$(vfm.solvedSubsidy)}</div>
        </div>
        <div className="bg-stone-900/40 border border-stone-700/60 rounded p-3">
          <div className="text-[10px] uppercase tracking-wider text-stone-500 mb-1">{vfm.p3SupportLabel}</div>
          <div className="text-lg font-medium text-stone-100">{fmt$(vfm.p3GovSupportNPV)}</div>
        </div>
      </div>
      {!vfm.apModeActive && (
        <div className="grid grid-cols-2 gap-4 mt-3">
          <Field label="Upfront Concession Fee (paid to public)"><NumInput value={v.upfrontConcessionFee} onChange={x=>setV({upfrontConcessionFee:x})} prefix="$" step={1000000}/></Field>
        </div>
      )}
      <p className="text-[10px] text-stone-500 mt-3">
        {vfm.apModeActive
          ? 'P3 cost = NPV of the optimizer-solved availability-payment stream (escalating) + public-share residual risk + public mitigation.'
          : 'P3 cost = NPV of the solved upfront subsidy + public-share residual risk + public mitigation − concession fee.'}
      </p>
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
            {vfm.pscUseLeverage ? <>
              <tr><TD mono={false} className="text-stone-300">Capex — public gap (upfront)</TD><TD className="text-right text-stone-200">{fmt$(vfm.pscCapexGapNPV)}</TD></tr>
              <tr><TD mono={false} className="text-stone-300">Capex — debt service NPV <span className="text-stone-500">({fmtPct(vfm.debtCoverFrac,0)} debt-funded)</span></TD><TD className="text-right text-stone-200">{fmt$(vfm.pscDebtServiceNPV)}</TD></tr>
            </> : (
              <tr><TD mono={false} className="text-stone-300">Capex NPV (100% public cash)</TD><TD className="text-right text-stone-200">{fmt$(vfm.pscCapexNPV)}</TD></tr>
            )}
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
            <tr><TD mono={false} className="text-stone-300">{vfm.p3Components.supportLabel || 'Gov Support NPV'}</TD><TD className="text-right text-rose-300">{fmt$(vfm.p3Components.govSupportNPV||0)}</TD></tr>
            {!vfm.apModeActive && <>
              <tr><TD mono={false} className="text-stone-300">(−) Upfront Concession Fee</TD><TD className="text-right text-emerald-300">({fmt$(vfm.p3Components.upfrontFee||0)})</TD></tr>
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
            <XAxis dataKey="owner" stroke="#a8a29e" tick={{fontSize:11}}/>
            <YAxis stroke="#a8a29e" tick={{fontSize:11}} label={{value:'$M (EV)',angle:-90,position:'insideLeft',fill:'#a8a29e',fontSize:11}}/>
            <Tooltip contentStyle={{background:'#1c1917',border:'1px solid #44403c',fontSize:12}} formatter={v=>`$${(v).toFixed(2)}M`}/>
            <Legend wrapperStyle={{fontSize:11}}/>
            <Bar dataKey="Construction" stackId="r" fill="#fb923c"/>
            <Bar dataKey="Operations" stackId="r" fill="#a78bfa"/>
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
  {id:'cashflow',label:'Cashflow'},{id:'su',label:'S&U'},{id:'tifiaSchedule',label:'TIFIA Schedule'},
  {id:'dashboard',label:'Dashboard'},{id:'chat',label:'Assistant'},
];

export default function App(){
  const [model, setModel] = useState(()=>{
    const DM = defaultModel();  // factory — call it once
    // State migration: patch old saved states missing sub1, tifia.instrumentId, etc.
    const migrateModel = (m) => {
      if(!m || !m.financing || !m.general) return DM;  // corrupt → reset
      // 1. Patch tifia config — old saves may lack instrumentId or capPeriodMonths
      const tifia = m.tifia
        ? { ...DM.tifia, ...m.tifia,
            instrumentId: m.tifia.instrumentId || 'tifia1',
            capPeriodMonths: m.tifia.capPeriodMonths || 6 }
        : { ...DM.tifia };
      // Migrate Major Maintenance: remove old annualized rmm/tmm opex + old mmrTargetSchedule
      let mOpex = m.opex;
      if(mOpex?.items?.some(it => it.id==='rmm' || it.id==='tmm')){
        mOpex = {...mOpex, items: mOpex.items.filter(it => it.id!=='rmm' && it.id!=='tmm')};
      }
      let mCA = m.controlAccounts || {};
      if(!mCA.mmEventSchedule){
        mCA = {...DM.controlAccounts, ...mCA, mmEventSchedule: DM.controlAccounts.mmEventSchedule, mmInflation: DM.controlAccounts.mmInflation};
        delete mCA.mmrTargetSchedule;
      }
      // 2. Add sub1 if missing
      const hasSub1 = m.financing.instruments?.some(i => i.id === 'sub1');
      const insts = hasSub1 ? m.financing.instruments : [
        {id:'sub1',type:'Upfront Subsidy',amount:0,rate:0,tenorYears:0,
         closeDate:m.general.financialCloseDate||'2026-07-01',
         seniority:'Grant',repaymentStyle:'Bullet',drawdownPriority:0,targetDSCR:0,
         ioYears:0,deferralYears:0,dayCount:'30/360',
         covenants:'Government viability gap funding — sized by Optimizer',
         issuanceCost:0,issuanceCostEscalation:0},
        ...m.financing.instruments
      ];
      // 3. Fix plug from fg1 → sub1
      const opt = m.optimizer || {}, cas = opt.cascade || {};
      const plugId = (cas.plugInstrumentId === 'fg1' || !cas.plugInstrumentId) ? 'sub1' : cas.plugInstrumentId;
      // Always return a complete model merged over defaults so nothing is missing
      return {
        ...DM,   // base — ensures every key exists
        ...m,    // user values override
        general:    {...DM.general,    ...(m.general||{}),
          governmentSupportMode: (m.general||{}).governmentSupportMode || 'subsidy',
          apEscalation: (m.general||{}).apEscalation ?? 0.025,
          targetGearing: (m.general||{}).targetGearing ?? 0.75},
        tifia,
        opex: mOpex || DM.opex,
        controlAccounts: mCA,
        financing:  {...DM.financing,  ...m.financing, instruments:insts},
        optimizer:  {...DM.optimizer,  ...opt, plugInstrumentId:plugId,
          cascade:{...(DM.optimizer.cascade||{}), ...cas, plugInstrumentId:plugId,
            tifiaEnabled: cas.tifiaEnabled !== false}},
      };
    };
    // Start with fresh default. Saved scenarios are loaded explicitly via the Load button.
    return DM;
  });
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
  const results = useMemo(()=>{ try { return buildFullModel(model); } catch(e){ console.error("Model build error:", e); return null; } }, [model]);
  const saveScenario = ()=>{
    if(!scenarioName.trim()) return;
    try { localStorage.setItem(`scenario:${scenarioName}`, JSON.stringify(model));
      setSavedScenarios(listScenarios()); setScenarioName(''); } catch(e){ console.error(e); }
  };
  const loadScenario = (key)=>{
    try {
      const raw = localStorage.getItem(key);
      if(raw){
        const loaded = JSON.parse(raw);
        // Apply same migration to loaded scenarios
        const hasSub1 = loaded.financing?.instruments?.some(i=>i.id==='sub1');
        const insts = hasSub1 ? loaded.financing.instruments : [
          {id:'sub1',type:'Upfront Subsidy',amount:0,rate:0,tenorYears:0,
           closeDate:loaded.general?.financialCloseDate||'2026-07-01',seniority:'Grant',
           repaymentStyle:'Bullet',drawdownPriority:0,targetDSCR:0,ioYears:0,deferralYears:0,
           dayCount:'30/360',covenants:'Government viability gap funding — sized by Optimizer',
           issuanceCost:0,issuanceCostEscalation:0},
          ...loaded.financing.instruments
        ];
        const opt = loaded.optimizer||{}, cas = opt.cascade||{};
        const plugId = (cas.plugInstrumentId==='fg1'||!cas.plugInstrumentId)?'sub1':cas.plugInstrumentId;
        setModel({...loaded, financing:{...loaded.financing, instruments:insts},
          optimizer:{...opt, plugInstrumentId:plugId, cascade:{...cas, plugInstrumentId:plugId}}});
      }
    } catch(e){ console.error(e); }
  };
  if(!results) return <div className="min-h-screen bg-stone-950 text-rose-300 p-8 font-mono"><div className="text-lg mb-2">Model error</div><div className="text-sm mb-4">Check browser console (F12) for details. If this persists, click Reset.</div><button onClick={()=>{localStorage.clear();window.location.reload();}} className="px-4 py-2 bg-amber-500 text-stone-900 rounded text-sm">Reset to Defaults</button></div>;
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
        {tab==='tifiaSchedule' && <TifiaScheduleTab model={model} results={results}/>}
        {tab==='dashboard' && <DashboardTab model={model} results={results}/>}
        {tab==='chat' && <ChatTab model={model} setModel={setModel} results={results}/>}
      </main>
      <footer className="border-t border-stone-800 px-6 py-3 text-[10px] uppercase tracking-wider text-stone-600">
        v2 — Toll Road PF · Period framework · Full TIFIA · Paygo · Optimizer · 1.0x test · Client-side
      </footer>
    </div>
  );
}
