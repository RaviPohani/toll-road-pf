"""
toll_road_pf.py — US Toll Road Project Finance Model (Python engine)

Pure-function port of the JS engine. JSON-compatible: the model dict
matches the structure produced by the React frontend, so you can:

    import json
    from toll_road_pf import build_full_model

    with open('scenario.json') as f:
        model = json.load(f)
    results = build_full_model(model)
    print(f"Equity IRR: {results['equity_irr']:.2%}")

Includes:
  * Period framework (semi-annual / annual, FY/CY, partial periods)
  * Full TIFIA: act/act construction interest, semi-annual cap, tenor spread,
    50% outstanding test with TRUE joint sculpt solver
  * Lockup escrow account
  * Control accounts (DSRA, O&M, ramp-up, MMR)
  * Single-instrument and iterative multi-tranche optimizers

Requires only the Python standard library.
"""

from __future__ import annotations
import math
import copy
import json
from datetime import datetime, date
from typing import List, Dict, Any, Optional, Callable, Tuple
from calendar import monthrange


# ============================================================
# CONSTANTS
# ============================================================
REPAYMENT_STYLES = [
    'Sculpted (target DSCR)', 'Level debt service', 'Equal principal',
    'Bullet', 'IO then amortize', 'Deferred P&I then sculpted',
    'Phased (multi-regime)', 'Custom schedule',
]
PHASE_REGIMES = ['defer', 'io', 'sculpt', 'level', 'equal-principal']
CURVE_TYPES = ['Linear', 'S-curve', 'Front-loaded', 'Back-loaded', 'Custom']
DAY_COUNT = ['Actual/Actual', 'Actual/360', '30/360']
WATERFALL_MODES = ['Opex-first (CFADS \u2192 DS)', 'Debt-first (Revenue \u2192 DS \u2192 Opex)']


# ============================================================
# DATE UTILITIES
# ============================================================
def parse_date(s: Optional[str]) -> datetime:
    if not s:
        return datetime(2026, 7, 1)
    return datetime.strptime(s, '%Y-%m-%d')


def add_months(d: datetime, n: int) -> datetime:
    total = d.year * 12 + (d.month - 1) + n
    y, m = divmod(total, 12)
    last_day = monthrange(y, m + 1)[1]
    return datetime(y, m + 1, min(d.day, last_day))


def days_between(a: datetime, b: datetime) -> int:
    return (b.date() - a.date()).days


def is_leap(y: int) -> bool:
    return (y % 4 == 0 and y % 100 != 0) or (y % 400 == 0)


def days_in_year(y: int) -> int:
    return 366 if is_leap(y) else 365


def dcf_act_act(start: datetime, end: datetime) -> float:
    f, cur = 0.0, start
    while cur < end:
        y = cur.year
        year_end = datetime(y + 1, 1, 1)
        chunk_end = min(end, year_end)
        f += days_between(cur, chunk_end) / days_in_year(y)
        cur = chunk_end
    return f


def dcf_act_360(s: datetime, e: datetime) -> float:
    return days_between(s, e) / 360.0


def dcf_30_360(s: datetime, e: datetime) -> float:
    d1 = min(30, s.day)
    d2 = min(30, e.day) if d1 == 30 else e.day
    days = 360 * (e.year - s.year) + 30 * (e.month - s.month) + (d2 - d1)
    return days / 360.0


def day_count_fraction(s: datetime, e: datetime, convention: str) -> float:
    if convention == 'Actual/360':
        return dcf_act_360(s, e)
    if convention == '30/360':
        return dcf_30_360(s, e)
    return dcf_act_act(s, e)


# ============================================================
# DEFAULT MODEL
# ============================================================
def default_model() -> Dict[str, Any]:
    return {
        'general': {
            'projectName': 'I-XXX Express Lanes',
            'sponsor': 'Concessionaire LLC',
            'state': 'Texas',
            'financialCloseDate': '2026-07-01',
            'constructionMonths': 36,
            'operationsYears': 30,
            'discountRate': 0.07,
            'periodsPerYear': 2,
            'useFiscalYear': False,
            'fyStartMonth': 7,
        },
        'waterfall': {'mode': WATERFALL_MODES[0], 'overallObligationMin': 1.00},
        'capex': {
            'inflationDefault': 0.025, 'curveDefault': 'S-curve',
            'useDirectForecast': False, 'directForecast': [],
            'items': [
                {'id': 'eng', 'label': 'D&B \u2014 Engineering',   'base': 15_000_000,  'inflate': True,  'inflRate': 0.025, 'curve': 'S-curve',      'group': 'D&B'},
                {'id': 'des', 'label': 'D&B \u2014 Design',        'base': 22_000_000,  'inflate': True,  'inflRate': 0.025, 'curve': 'S-curve',      'group': 'D&B'},
                {'id': 'arc', 'label': 'D&B \u2014 Architecture',  'base':  8_000_000,  'inflate': True,  'inflRate': 0.025, 'curve': 'S-curve',      'group': 'D&B'},
                {'id': 'mat', 'label': 'D&B \u2014 Materials',     'base': 240_000_000, 'inflate': True,  'inflRate': 0.035, 'curve': 'S-curve',      'group': 'D&B'},
                {'id': 'lab', 'label': 'D&B \u2014 Labor',         'base': 180_000_000, 'inflate': True,  'inflRate': 0.030, 'curve': 'S-curve',      'group': 'D&B'},
                {'id': 'uti', 'label': 'D&B \u2014 Utilities',     'base':  35_000_000, 'inflate': True,  'inflRate': 0.025, 'curve': 'Front-loaded', 'group': 'D&B'},
                {'id': 'mob', 'label': 'D&B \u2014 Mobilization',  'base':  12_000_000, 'inflate': False, 'inflRate': 0.0,   'curve': 'Front-loaded', 'group': 'D&B'},
                {'id': 'oth', 'label': 'D&B \u2014 Other',         'base':  18_000_000, 'inflate': True,  'inflRate': 0.025, 'curve': 'S-curve',      'group': 'D&B'},
                {'id': 'spv', 'label': 'SPV costs during constr.', 'base':   9_000_000, 'inflate': True,  'inflRate': 0.025, 'curve': 'Linear',       'group': 'D&B'},
                {'id': 'row', 'label': 'Right of Way',             'base':  45_000_000, 'inflate': True,  'inflRate': 0.030, 'curve': 'Front-loaded', 'group': 'Other'},
                {'id': 'ure', 'label': 'Utility Relocation',       'base':  22_000_000, 'inflate': True,  'inflRate': 0.025, 'curve': 'Front-loaded', 'group': 'Other'},
                {'id': 'env', 'label': 'Environmental Clearance',  'base':   6_500_000, 'inflate': False, 'inflRate': 0.0,   'curve': 'Front-loaded', 'group': 'Other'},
                {'id': 'adv', 'label': 'Advisory & Legal',         'base':  11_000_000, 'inflate': False, 'inflRate': 0.0,   'curve': 'Linear',       'group': 'Other'},
                {'id': 'res', 'label': 'Reserve Deposits',         'base':  28_000_000, 'inflate': False, 'inflRate': 0.0,   'curve': 'Back-loaded',  'group': 'Other'},
            ],
        },
        'paygo': {'enabled': True, 'totalContribution': 35_000_000, 'distributionCurve': 'Linear',
                  'description': 'Net existing toll revenues used as paygo during construction.'},
        'revenue': {
            'useDirectForecast': False, 'directForecast': [],
            'inflate': True, 'tollEscalation': 0.025,
            'aadtY1': 42_000, 'aadtRamp': [0.55, 0.75, 0.90, 0.97, 1.00],
            'vehicleClasses': [
                {'id': 'c2', 'name': 'Class 2', 'toll':  2.50, 'share': 0.78, 'growthRate': 0.020},
                {'id': 'c3', 'name': 'Class 3', 'toll':  5.00, 'share': 0.12, 'growthRate': 0.020},
                {'id': 'c4', 'name': 'Class 4', 'toll':  8.00, 'share': 0.05, 'growthRate': 0.015},
                {'id': 'c5', 'name': 'Class 5', 'toll': 11.00, 'share': 0.03, 'growthRate': 0.015},
                {'id': 'c6', 'name': 'Class 6', 'toll': 15.00, 'share': 0.02, 'growthRate': 0.015},
            ],
            'daysOpen': 365,
        },
        'opex': {
            'useDirectForecast': False, 'directForecast': [], 'inflate': True, 'inflRate': 0.025,
            'items': [
                {'id': 'rom', 'label': 'Roadway O&M',                 'base': 4_500_000},
                {'id': 'rmm', 'label': 'Roadway Major Maintenance',   'base': 6_200_000},
                {'id': 'tom', 'label': 'Tolling O&M',                 'base': 2_800_000},
                {'id': 'tmm', 'label': 'Tolling Major Maintenance',   'base': 1_400_000},
                {'id': 'clp', 'label': 'Toll Collection \u2014 LPR',  'base': 0.45, 'perTxn': True, 'share': 0.35},
                {'id': 'cvi', 'label': 'Toll Collection \u2014 Video','base': 0.08, 'perTxn': True, 'share': 0.65},
            ],
        },
        'financing': {
            'instruments': [
                {'id': 'eq1',    'type': 'Sponsor Equity',     'amount': 120_000_000, 'rate': 0.0,    'tenorYears': 30,
                 'closeDate': '2026-07-01', 'seniority': 'Equity',      'repaymentStyle': 'Sculpted (target DSCR)',
                 'drawdownPriority': 5, 'targetDSCR': 1.30, 'ioYears': 0, 'deferralYears': 0,
                 'dayCount': '30/360', 'covenants': 'Distribution lockup if TIFIA lockup',
                 'issuanceCost': 0, 'issuanceCostEscalation': 0.0},
                {'id': 'fg1',    'type': 'Federal Grant',      'amount':  60_000_000, 'rate': 0.0,    'tenorYears': 0,
                 'closeDate': '2026-07-01', 'seniority': 'Grant',       'repaymentStyle': 'Bullet',
                 'drawdownPriority': 1, 'targetDSCR': 0, 'ioYears': 0, 'deferralYears': 0,
                 'dayCount': '30/360', 'covenants': '',
                 'issuanceCost': 250_000, 'issuanceCostEscalation': 0.03},
                {'id': 'sg1',    'type': 'State Grant',        'amount':  40_000_000, 'rate': 0.0,    'tenorYears': 0,
                 'closeDate': '2026-07-01', 'seniority': 'Grant',       'repaymentStyle': 'Bullet',
                 'drawdownPriority': 1, 'targetDSCR': 0, 'ioYears': 0, 'deferralYears': 0,
                 'dayCount': '30/360', 'covenants': '',
                 'issuanceCost': 150_000, 'issuanceCostEscalation': 0.03},
                {'id': 'pab1',   'type': 'PABs',               'amount': 280_000_000, 'rate': 0.0525, 'tenorYears': 30,
                 'closeDate': '2026-07-01', 'seniority': 'Senior',      'repaymentStyle': 'Level debt service',
                 'drawdownPriority': 3, 'targetDSCR': 1.35, 'ioYears': 0, 'deferralYears': 3,
                 'dayCount': '30/360', 'covenants': 'Senior DSCR \u22651.20x',
                 'issuanceCost': 4_500_000, 'issuanceCostEscalation': 0.03},
                {'id': 'tifia1', 'type': 'TIFIA Loan',         'amount': 200_000_000, 'rate': 0.0410, 'tenorYears': 35,
                 'closeDate': '2026-07-01', 'seniority': 'Subordinate', 'repaymentStyle': 'Phased (multi-regime)',
                 'drawdownPriority': 4, 'targetDSCR': 1.10, 'ioYears': 0, 'deferralYears': 5,
                 'dayCount': 'Actual/Actual', 'covenants': 'TIFIA springing lien',
                 'issuanceCost': 1_750_000, 'issuanceCostEscalation': 0.03,
                 'phases': [
                     {'regime': 'defer', 'endPeriod': 10, 'targetDSCR': None},                                      # CapI 5y
                     {'regime': 'io',    'endPeriod': 20, 'targetDSCR': None},                                      # IO 5y
                     {'regime': 'level', 'endPeriod': 50, 'targetEndBalance': 100_000_000, 'targetDSCR': None},     # Annuity to 50% @ test point
                     {'regime': 'level', 'endPeriod': 70, 'targetEndBalance': 0, 'targetDSCR': None},               # Level 10y to maturity
                 ]},
                {'id': 'ran1',   'type': 'RAN',                'amount':  50_000_000, 'rate': 0.0350, 'tenorYears': 2,
                 'closeDate': '2026-07-01', 'seniority': 'Short-term',  'repaymentStyle': 'Bullet',
                 'drawdownPriority': 2, 'targetDSCR': 0, 'ioYears': 0, 'deferralYears': 0,
                 'dayCount': 'Actual/360', 'covenants': 'Repaid from first revenues',
                 'issuanceCost': 350_000, 'issuanceCostEscalation': 0.03},
            ],
            'financingFeesPctOfDebt': 0.015,
            'blendedIDCRateForNonTIFIA': 0.0525,
            'issuanceCostBaseYear': 2024,   # year issuance costs were quoted; escalated to FC year
        },
        'tifia': {
            'instrumentId': 'tifia1', 'treasuryRate': 0.0395,
            'spreadBps': 1, 'useTenorSpreadCurve': True,
            'tenorSpreadCurve': [{'maxTenor': 10, 'bps': 0}, {'maxTenor': 20, 'bps': 1}, {'maxTenor': 35, 'bps': 1}],
            'capInterestSemiAnnually': True, 'capPeriodMonths': 6,
            'fiftyPercentTestYearsBeforeMaturity': 10, 'enforce50PctTest': True,
            'minDSCR': 1.10, 'minLLCR': 1.30, 'minPLCR': 1.40, 'maxWAL': 25,
            'lockupDSCR': 1.20, 'lockupLLCR': 1.20,
            'adminFeeAnnual': 13_500,     # USD/yr fixed admin fee (US DOT TIFIA standard ~$13.5k)
            'monitoringFeeBps': 7.5,      # bps/yr on outstanding TIFIA balance
        },
        'controlAccounts': {
            'dsraMonthsDS': 6, 'omReserveMonths': 3,
            'rampUpReserveAmount': 15_000_000, 'rampUpReleaseYears': 5,
            'mmrTargetSchedule': [
                {'yearStart': 1,  'annualFunding': 2_500_000},
                {'yearStart': 10, 'annualFunding': 5_000_000},
                {'yearStart': 20, 'annualFunding': 8_000_000},
            ],
        },
        'vfm': {
            'pscDiscountRate': 0.045,
            'pscCostPremium': 0.08,
            'competitiveNeutralityPct': 0.03,
            'isAvailabilityBased': False,
            'upfrontConcessionFee': 50_000_000,
            'revenueSharePct': 0.05,
            'availabilityPaymentAnnual': 60_000_000,
            'availabilityEscalation': 0.020,
            'availabilityStartYear': 3,
            'availabilityYears': 30,
            'riskRegister': [
                {'id':'rc1', 'category':'Construction Cost Overrun (D&B)',  'phase':'construction', 'probability':0.40, 'impactLow':10_000_000, 'impactMostLikely':35_000_000, 'impactHigh':90_000_000, 'shareToPrivate':0.85, 'mitigationCost':3_000_000, 'mitigationOwner':'private', 'probReduction':0.25, 'impactReduction':0.20, 'notes':'Materials, labor, change orders'},
                {'id':'rc2', 'category':'Construction Schedule Delay',      'phase':'construction', 'probability':0.45, 'impactLow':5_000_000,  'impactMostLikely':18_000_000, 'impactHigh':55_000_000, 'shareToPrivate':0.90, 'mitigationCost':2_000_000, 'mitigationOwner':'private', 'probReduction':0.30, 'impactReduction':0.25, 'notes':'Delay damages + carrying costs'},
                {'id':'rc3', 'category':'ROW Acquisition',                  'phase':'construction', 'probability':0.30, 'impactLow':3_000_000,  'impactMostLikely':12_000_000, 'impactHigh':40_000_000, 'shareToPrivate':0.20, 'mitigationCost':1_500_000, 'mitigationOwner':'public',  'probReduction':0.20, 'impactReduction':0.15, 'notes':'Early condemnation / pre-clearance'},
                {'id':'rc4', 'category':'Utility Relocation Overrun',       'phase':'construction', 'probability':0.35, 'impactLow':2_000_000,  'impactMostLikely':8_000_000,  'impactHigh':25_000_000, 'shareToPrivate':0.50, 'mitigationCost':1_000_000, 'mitigationOwner':'shared',  'probReduction':0.25, 'impactReduction':0.20, 'notes':'Early utility coordination'},
                {'id':'rc5', 'category':'Geotechnical / Site Conditions',   'phase':'construction', 'probability':0.25, 'impactLow':4_000_000,  'impactMostLikely':15_000_000, 'impactHigh':50_000_000, 'shareToPrivate':0.70, 'mitigationCost':2_500_000, 'mitigationOwner':'private', 'probReduction':0.30, 'impactReduction':0.25, 'notes':'Pre-bid surveys'},
                {'id':'rc6', 'category':'Permitting / Environmental Delays','phase':'construction', 'probability':0.20, 'impactLow':2_000_000,  'impactMostLikely':10_000_000, 'impactHigh':35_000_000, 'shareToPrivate':0.30, 'mitigationCost':1_500_000, 'mitigationOwner':'public',  'probReduction':0.40, 'impactReduction':0.30, 'notes':'Early NEPA / agency engagement'},
                {'id':'ro1', 'category':'Traffic Demand Shortfall',         'phase':'operations',   'probability':0.55, 'impactLow':-3_000_000, 'impactMostLikely':5_000_000,  'impactHigh':18_000_000, 'shareToPrivate':0.95, 'mitigationCost':500_000,   'mitigationOwner':'private', 'probReduction':0.15, 'impactReduction':0.20, 'notes':'Marketing + tolling promotions'},
                {'id':'ro2', 'category':'O&M Cost Overrun',                 'phase':'operations',   'probability':0.40, 'impactLow':500_000,    'impactMostLikely':2_000_000,  'impactHigh':6_000_000,  'shareToPrivate':0.85, 'mitigationCost':200_000,   'mitigationOwner':'private', 'probReduction':0.30, 'impactReduction':0.25, 'notes':'Performance-based contracts'},
                {'id':'ro3', 'category':'Major Maintenance Cost Overrun',   'phase':'operations',   'probability':0.50, 'impactLow':1_000_000,  'impactMostLikely':4_000_000,  'impactHigh':15_000_000, 'shareToPrivate':0.90, 'mitigationCost':400_000,   'mitigationOwner':'private', 'probReduction':0.25, 'impactReduction':0.30, 'notes':'Lifecycle / predictive maint.'},
                {'id':'ro4', 'category':'Tolling Technology Obsolescence',  'phase':'operations',   'probability':0.30, 'impactLow':1_000_000,  'impactMostLikely':3_000_000,  'impactHigh':10_000_000, 'shareToPrivate':0.75, 'mitigationCost':300_000,   'mitigationOwner':'private', 'probReduction':0.20, 'impactReduction':0.30, 'notes':'Tech refresh sinking fund'},
                {'id':'ro5', 'category':'Force Majeure / Insurance Gap',    'phase':'operations',   'probability':0.15, 'impactLow':2_000_000,  'impactMostLikely':8_000_000,  'impactHigh':30_000_000, 'shareToPrivate':0.40, 'mitigationCost':600_000,   'mitigationOwner':'shared',  'probReduction':0.10, 'impactReduction':0.40, 'notes':'Catastrophe insurance'},
                {'id':'ro6', 'category':'Change in Law / Regulation',       'phase':'operations',   'probability':0.20, 'impactLow':500_000,    'impactMostLikely':2_500_000,  'impactHigh':12_000_000, 'shareToPrivate':0.20, 'mitigationCost':150_000,   'mitigationOwner':'public',  'probReduction':0.10, 'impactReduction':0.20, 'notes':'Legal monitoring + advocacy'},
            ],
        },
    }


# ============================================================
# HELPERS
# ============================================================
def _sum(arr): return sum(x for x in arr if x is not None)


def _zeros(n): return [0.0] * n


def _avg(arr):
    arr = [x for x in arr if x is not None and math.isfinite(x)]
    return sum(arr) / len(arr) if arr else 0.0


# ============================================================
# CURVE DISTRIBUTION
# ============================================================
def distribute_curve(total: float, periods: int, curve_type: str, custom: Optional[List[float]] = None) -> List[float]:
    if periods <= 0:
        return []
    if curve_type == 'Custom' and custom and len(custom) == periods:
        s = _sum(custom) or 1.0
        return [(v / s) * total for v in custom]
    idx = list(range(periods))
    if curve_type == 'Linear':
        w = [1.0 for _ in idx]
    elif curve_type == 'S-curve':
        k = 8 / periods
        m = (periods - 1) / 2
        cdf = [1 / (1 + math.exp(-k * (i - m))) for i in idx]
        w = [cdf[0]] + [cdf[i] - cdf[i - 1] for i in range(1, periods)]
    elif curve_type == 'Front-loaded':
        w = [math.exp(-3 * (i / max(1, periods - 1))) for i in idx]
    elif curve_type == 'Back-loaded':
        w = [math.exp(3 * (i / max(1, periods - 1)) - 3) for i in idx]
    else:
        w = [1.0 for _ in idx]
    ws = _sum(w) or 1.0
    return [(x / ws) * total for x in w]


def inflate_month(base: float, rate: float, month_idx: int) -> float:
    return base * ((1 + rate) ** (month_idx / 12))


# ============================================================
# PERIOD FRAMEWORK
# ============================================================
def generate_operating_periods(model: Dict[str, Any]) -> List[Dict[str, Any]]:
    fin_close = parse_date(model['general']['financialCloseDate'])
    ops_start = add_months(fin_close, model['general']['constructionMonths'])
    ops_end = add_months(ops_start, model['general']['operationsYears'] * 12)
    ppy = model['general'].get('periodsPerYear', 2)
    mpp = 12 // ppy
    y_start = model['general'].get('fyStartMonth', 7) if model['general'].get('useFiscalYear') else 1

    periods = []
    cursor = ops_start
    safety = 0
    while cursor < ops_end and safety < 500:
        safety += 1
        cm = cursor.month
        if cm >= y_start:
            base_year = cursor.year
            months_in = cm - y_start
        else:
            base_year = cursor.year - 1
            months_in = 12 - y_start + cm
        period_idx = months_in // mpp
        full_start_abs_month = y_start - 1 + period_idx * mpp
        full_start_year = base_year + full_start_abs_month // 12
        full_start_month = full_start_abs_month % 12 + 1
        full_period_start = datetime(full_start_year, full_start_month, 1)
        full_period_end = add_months(full_period_start, mpp)
        period_end = full_period_end if full_period_end < ops_end else ops_end
        days = days_between(cursor, period_end)
        full_days = days_between(full_period_start, full_period_end)
        periods.append({
            'idx': len(periods),
            'start': cursor, 'end': period_end,
            'days': days, 'fullDays': full_days,
            'yearFraction': days / days_in_year(cursor.year),
            'dayFraction': days / full_days if full_days > 0 else 1.0,
            'isPartial': days < full_days,
            'label': f"{cursor.strftime('%b-%y')}/{period_end.strftime('%b-%y')}",
        })
        cursor = period_end
    return periods


# ============================================================
# CAPEX SCHEDULE
# ============================================================
def build_capex_schedule(model: Dict[str, Any]) -> Dict[str, Any]:
    months = model['general']['constructionMonths']
    result = {'monthly': _zeros(months), 'byItem': {}, 'totalNominal': 0.0, 'totalBase': 0.0}
    if model['capex'].get('useDirectForecast') and model['capex'].get('directForecast'):
        for row in model['capex']['directForecast']:
            m = max(0, min(months - 1, (row.get('month', 1) - 1)))
            result['monthly'][m] += row.get('total', 0)
        result['totalNominal'] = _sum(result['monthly'])
        result['totalBase'] = result['totalNominal']
        result['byItem']['direct'] = list(result['monthly'])
        return result
    for item in model['capex']['items']:
        base_dist = distribute_curve(item['base'], months, item['curve'], item.get('customCurve'))
        nominal = [inflate_month(v, item['inflRate'], i) if item['inflate'] else v
                   for i, v in enumerate(base_dist)]
        result['byItem'][item['id']] = nominal
        for i, v in enumerate(nominal):
            result['monthly'][i] += v
        result['totalNominal'] += _sum(nominal)
        result['totalBase'] += item['base']
    return result


def build_paygo_schedule(model: Dict[str, Any]) -> Dict[str, Any]:
    months = model['general']['constructionMonths']
    if not model['paygo'].get('enabled'):
        return {'monthly': _zeros(months), 'total': 0.0}
    dist = distribute_curve(model['paygo']['totalContribution'], months, model['paygo']['distributionCurve'])
    return {'monthly': dist, 'total': _sum(dist)}


# ============================================================
# TIFIA CONSTRUCTION INTEREST
# ============================================================
def build_tifia_construction_interest(tifia_inst: Dict[str, Any], tifia_monthly_draws: List[float],
                                      tifia_cfg: Dict[str, Any], model: Dict[str, Any]) -> Dict[str, Any]:
    fin_close = parse_date(model['general']['financialCloseDate'])
    months = len(tifia_monthly_draws)
    cap_months = tifia_cfg.get('capPeriodMonths', 6)
    balance, accrued = 0.0, 0.0
    monthly_interest = _zeros(months)
    monthly_balance = _zeros(months)
    capitalizations = []
    for m in range(months):
        ms = add_months(fin_close, m)
        me = add_months(fin_close, m + 1)
        dcf = day_count_fraction(ms, me, tifia_inst.get('dayCount', 'Actual/Actual'))
        int_m = balance * tifia_inst['rate'] * dcf
        accrued += int_m
        monthly_interest[m] = int_m
        balance += tifia_monthly_draws[m] or 0
        if (m + 1) % cap_months == 0 or m == months - 1:
            if accrued > 0:
                balance += accrued
                capitalizations.append({'monthIdx': m, 'amount': accrued})
                accrued = 0
        monthly_balance[m] = balance
    return {
        'monthlyInterest': monthly_interest, 'monthlyBalance': monthly_balance,
        'capitalizations': capitalizations,
        'capitalizedInterestTotal': _sum(c['amount'] for c in capitalizations),
        'finalBalance': balance,
    }


def tifia_spread_bps(tenor: float, cfg: Dict[str, Any]) -> float:
    if not cfg.get('useTenorSpreadCurve'):
        return cfg.get('spreadBps', 0)
    sorted_curve = sorted(cfg.get('tenorSpreadCurve', []), key=lambda r: r['maxTenor'])
    for r in sorted_curve:
        if tenor <= r['maxTenor']:
            return r['bps']
    return sorted_curve[-1]['bps'] if sorted_curve else 0


def tifia_all_in_rate(tenor: float, cfg: Dict[str, Any]) -> float:
    return (cfg.get('treasuryRate', 0) or 0) + tifia_spread_bps(tenor, cfg) / 10000


# ============================================================
# REVENUE & OPEX (PERIOD)
# ============================================================
def build_revenue_schedule(model: Dict[str, Any], periods: List[Dict[str, Any]]) -> Dict[str, Any]:
    n = len(periods)
    out = {'byPeriod': _zeros(n), 'byClass': {}, 'aadtByPeriod': _zeros(n)}
    if model['revenue'].get('useDirectForecast') and model['revenue'].get('directForecast'):
        by_year = {row['year'] - 1: row.get('total', 0) for row in model['revenue']['directForecast']}
        cum_y = 0.0
        for i, p in enumerate(periods):
            y = int(cum_y)
            out['byPeriod'][i] = by_year.get(y, 0) * p['yearFraction']
            cum_y += p['yearFraction']
        return out
    r = model['revenue']
    cum_y = 0.0
    for i, p in enumerate(periods):
        y = int(cum_y)
        ramp_idx = min(y, len(r['aadtRamp']) - 1)
        period_rev = 0.0
        aadt_total = 0.0
        for c in r['vehicleClasses']:
            aadt_c = r['aadtY1'] * r['aadtRamp'][ramp_idx] * c['share'] * ((1 + c['growthRate']) ** y)
            toll = c['toll'] * ((1 + r['tollEscalation']) ** y) if r['inflate'] else c['toll']
            annual_class = aadt_c * toll * r['daysOpen']
            period_class = annual_class * p['yearFraction']
            period_rev += period_class
            aadt_total += aadt_c
            out['byClass'].setdefault(c['id'], _zeros(n))[i] = period_class
        out['byPeriod'][i] = period_rev
        out['aadtByPeriod'][i] = aadt_total
        cum_y += p['yearFraction']
    return out


def build_opex_schedule(model: Dict[str, Any], periods: List[Dict[str, Any]],
                         rev_sched: Dict[str, Any]) -> Dict[str, Any]:
    n = len(periods)
    out = {'byPeriod': _zeros(n), 'byItem': {}}
    if model['opex'].get('useDirectForecast') and model['opex'].get('directForecast'):
        by_year = {row['year'] - 1: row.get('total', 0) for row in model['opex']['directForecast']}
        cum_y = 0.0
        for i, p in enumerate(periods):
            y = int(cum_y)
            out['byPeriod'][i] = by_year.get(y, 0) * p['yearFraction']
            cum_y += p['yearFraction']
        return out
    rate = model['opex']['inflRate']
    for it in model['opex']['items']:
        out['byItem'][it['id']] = _zeros(n)
    cum_y = 0.0
    for i, p in enumerate(periods):
        y = int(cum_y)
        period_total = 0.0
        for it in model['opex']['items']:
            if it.get('perTxn'):
                aadt = rev_sched['aadtByPeriod'][i] or 0
                txns = aadt * 365 * (it.get('share', 0))
                cpt = it['base'] * ((1 + rate) ** y) if model['opex']['inflate'] else it['base']
                ann = txns * cpt
            else:
                ann = it['base'] * ((1 + rate) ** y) if model['opex']['inflate'] else it['base']
            pv = ann * p['yearFraction']
            out['byItem'][it['id']][i] = pv
            period_total += pv
        out['byPeriod'][i] = period_total
        cum_y += p['yearFraction']
    return out


# ============================================================
# DEBT SCHEDULE PRIMITIVES
# ============================================================
def sculpt_to_target(principal: float, rate_per: float, periods: List[Dict[str, Any]],
                     cfads: List[float], target: float, io_p: int, def_p: int) -> Dict[str, List[float]]:
    n = len(periods)
    interest, principal_arr, balance = _zeros(n), _zeros(n), _zeros(n)
    bal = principal
    for i in range(n):
        int_p = bal * rate_per
        if i < def_p:
            bal += int_p
            balance[i] = bal
            continue
        if i < def_p + io_p:
            interest[i] = int_p
            balance[i] = bal
            continue
        max_ds = (cfads[i] if i < len(cfads) else 0) / max(target, 0.0001)
        pri = max(0, min(bal, max_ds - int_p))
        interest[i] = int_p
        principal_arr[i] = pri
        bal -= pri
        balance[i] = bal
    return {'interest': interest, 'principal': principal_arr, 'balance': balance}


def level_debt(principal: float, rate_per: float, periods: List[Dict[str, Any]],
               io_p: int, def_p: int) -> Dict[str, List[float]]:
    n = len(periods)
    interest, principal_arr, balance = _zeros(n), _zeros(n), _zeros(n)
    bal = principal
    for i in range(min(def_p, n)):
        bal *= (1 + rate_per)
        balance[i] = bal
    for i in range(def_p, min(def_p + io_p, n)):
        interest[i] = bal * rate_per
        balance[i] = bal
    amort_start = def_p + io_p
    amort_p = max(1, n - amort_start)
    r = rate_per
    pmt = (bal * r) / (1 - (1 + r) ** -amort_p) if r > 0 else bal / amort_p
    for i in range(amort_start, n):
        int_p = bal * r
        pri = min(bal, pmt - int_p)
        interest[i] = int_p
        principal_arr[i] = pri
        bal -= pri
        balance[i] = bal
    return {'interest': interest, 'principal': principal_arr, 'balance': balance}


def equal_principal(principal: float, rate_per: float, periods: List[Dict[str, Any]],
                    io_p: int, def_p: int) -> Dict[str, List[float]]:
    n = len(periods)
    interest, principal_arr, balance = _zeros(n), _zeros(n), _zeros(n)
    bal = principal
    for i in range(min(def_p, n)):
        bal *= (1 + rate_per)
        balance[i] = bal
    for i in range(def_p, min(def_p + io_p, n)):
        interest[i] = bal * rate_per
        balance[i] = bal
    amort_start = def_p + io_p
    amort_p = max(1, n - amort_start)
    pri_each = bal / amort_p
    for i in range(amort_start, n):
        interest[i] = bal * rate_per
        pri = min(bal, pri_each)
        principal_arr[i] = pri
        bal -= pri
        balance[i] = bal
    return {'interest': interest, 'principal': principal_arr, 'balance': balance}


def bullet(principal: float, rate_per: float, periods: List[Dict[str, Any]]) -> Dict[str, List[float]]:
    n = len(periods)
    interest, principal_arr, balance = _zeros(n), _zeros(n), _zeros(n)
    bal = principal
    for i in range(n):
        interest[i] = bal * rate_per
        if i == n - 1:
            principal_arr[i] = bal
            bal = 0
        balance[i] = bal
    return {'interest': interest, 'principal': principal_arr, 'balance': balance}


def phased_schedule(principal: float, rate_per: float, periods: List[Dict[str, Any]],
                    cfads: List[float], phases: List[Dict[str, Any]],
                    original_principal: float) -> Dict[str, List[float]]:
    """Phased multi-regime repayment.

    Each phase: {'regime': defer|io|sculpt|level|equal-principal,
                 'endPeriod': int (exclusive),
                 'targetDSCR': float (only for sculpt)}

    Walks periods sequentially through phases. Last phase's endPeriod should equal
    tenor period count; any residual balance past the last phase bullets at maturity.
    """
    n = len(periods)
    interest, principal_arr, balance = _zeros(n), _zeros(n), _zeros(n)
    bal = principal
    if not phases:
        return bullet(principal, rate_per, periods)

    phase_idx = 0
    level_pmt = None              # cached on entry to a level phase
    equal_pri_per_period = None   # cached on entry to an equal-principal phase

    for i in range(n):
        # Advance through completed phases
        while phase_idx < len(phases) and i >= (phases[phase_idx].get('endPeriod') or n):
            phase_idx += 1
            level_pmt = None
            equal_pri_per_period = None

        if phase_idx >= len(phases):
            # Past last phase — accrue interest, bullet remaining at maturity
            interest[i] = bal * rate_per
            if i == n - 1:
                principal_arr[i] = bal
                bal = 0
            balance[i] = bal
            continue

        phase = phases[phase_idx]
        int_p = bal * rate_per
        phase_end = phase.get('endPeriod') or n
        periods_remaining_in_phase = phase_end - i
        regime = phase.get('regime')

        if regime == 'defer':
            # Interest capitalizes — no payment
            bal += int_p
            balance[i] = bal
        elif regime == 'io':
            interest[i] = int_p
            balance[i] = bal
        elif regime == 'sculpt':
            tgt = phase.get('targetDSCR') or 1.20
            max_ds = (cfads[i] if i < len(cfads) else 0) / max(tgt, 0.0001)
            pri = max(0, min(bal, max_ds - int_p))
            interest[i] = int_p
            principal_arr[i] = pri
            bal -= pri
            balance[i] = bal
        elif regime == 'level':
            if level_pmt is None:
                # Compute level pmt ONCE at phase entry. If targetEndBalance specified, solve to that;
                # otherwise fully amortize to zero (default behavior).
                n_p = periods_remaining_in_phase   # RENAMED from `n` to avoid shadowing outer `n = len(periods)`
                target_end = phase.get('targetEndBalance', 0) or 0
                if rate_per > 0:
                    grow = (1 + rate_per) ** n_p
                    level_pmt = (bal * grow - target_end) * rate_per / (grow - 1)
                else:
                    level_pmt = (bal - target_end) / max(1, n_p)
            pri = max(0, min(bal, level_pmt - int_p))
            interest[i] = int_p
            principal_arr[i] = pri
            bal -= pri
            balance[i] = bal
        elif regime == 'equal-principal':
            if equal_pri_per_period is None:
                equal_pri_per_period = bal / max(1, periods_remaining_in_phase)
            pri = min(bal, equal_pri_per_period)
            interest[i] = int_p
            principal_arr[i] = pri
            bal -= pri
            balance[i] = bal
        else:
            # Unknown regime — fallback to IO
            interest[i] = int_p
            balance[i] = bal

    # Safety: ensure any residual balance bullets at maturity (matches level/bullet behavior).
    # Triggers if user-defined phases don't fully amortize within the actual slice (e.g. tenor capped by ops period).
    if n > 0 and balance[n - 1] > 0:
        extra = balance[n - 1]
        principal_arr[n - 1] += extra
        balance[n - 1] = 0

    return {'interest': interest, 'principal': principal_arr, 'balance': balance}


# ============================================================
# 50% TEST — JOINT SOLVER + POST-HOC
# ============================================================
def find_test_idx(sched: Dict[str, List[float]], periods: List[Dict[str, Any]], years_before_mat: float) -> int:
    n = len(periods)
    last_pri = n - 1
    for i in range(n - 1, -1, -1):
        if sched['principal'][i] > 0:
            last_pri = i
            break
    test_idx = last_pri
    rem_y = 0.0
    for i in range(last_pri, -1, -1):
        rem_y += periods[i]['yearFraction']
        if rem_y >= years_before_mat:
            test_idx = i
            break
    return test_idx


def sculpt_with_fifty_pct_test(principal: float, rate_per: float, periods: List[Dict[str, Any]],
                                cfads: List[float], target_dscr: float, io_p: int, def_p: int,
                                original_principal: float, years_before_mat: float,
                                max_pct: float = 0.5) -> Dict[str, Any]:
    max_bal = original_principal * max_pct
    natural = sculpt_to_target(principal, rate_per, periods, cfads, target_dscr, io_p, def_p)
    test_idx = find_test_idx(natural, periods, years_before_mat)
    if natural['balance'][test_idx] <= max_bal + 1:
        return {'schedule': natural, 'effectiveDSCR': target_dscr, 'applied': False,
                'testIdx': test_idx, 'beforeBal': natural['balance'][test_idx],
                'maxAllowed': max_bal, 'naturalBalance': natural['balance'][test_idx]}
    lo, hi = 1.0001, target_dscr
    s_lo = sculpt_to_target(principal, rate_per, periods, cfads, lo, io_p, def_p)
    if s_lo['balance'][test_idx] > max_bal:
        return {'schedule': s_lo, 'effectiveDSCR': lo, 'applied': True,
                'testIdx': test_idx, 'beforeBal': natural['balance'][test_idx],
                'maxAllowed': max_bal, 'naturalBalance': natural['balance'][test_idx],
                'infeasible': True}
    best, best_dscr = s_lo, lo
    for _ in range(40):
        mid = (lo + hi) / 2
        s = sculpt_to_target(principal, rate_per, periods, cfads, mid, io_p, def_p)
        if s['balance'][test_idx] <= max_bal:
            best, best_dscr = s, mid
            lo = mid
        else:
            hi = mid
        if abs(hi - lo) < 0.001:
            break
    return {'schedule': best, 'effectiveDSCR': best_dscr, 'applied': True,
            'testIdx': test_idx, 'beforeBal': natural['balance'][test_idx],
            'maxAllowed': max_bal, 'naturalBalance': natural['balance'][test_idx]}


def apply_fifty_pct_test(sched: Dict[str, List[float]], periods: List[Dict[str, Any]],
                          original_principal: float, years_before_mat: float,
                          max_pct: float = 0.5) -> Dict[str, Any]:
    """Post-hoc principal redistribution for non-sculpted schedules."""
    n = len(periods)
    test_idx = find_test_idx(sched, periods, years_before_mat)
    max_allowed = original_principal * max_pct
    if sched['balance'][test_idx] <= max_allowed:
        return {'schedule': sched, 'applied': False, 'testIdx': test_idx,
                'beforeBal': sched['balance'][test_idx], 'maxAllowed': max_allowed}
    shortfall = sched['balance'][test_idx] - max_allowed
    ns = {'interest': list(sched['interest']), 'principal': list(sched['principal']),
          'balance': list(sched['balance'])}
    pri_after = _sum(ns['principal'][test_idx + 1:])
    if pri_after <= 0:
        return {'schedule': sched, 'applied': False, 'testIdx': test_idx,
                'beforeBal': sched['balance'][test_idx], 'maxAllowed': max_allowed}
    factor = min(1, shortfall / pri_after)
    moved = 0.0
    for i in range(test_idx + 1, n):
        red = ns['principal'][i] * factor
        ns['principal'][i] -= red
        moved += red
    early_p = max(1, test_idx + 1)
    add_per = moved / early_p
    for i in range(test_idx + 1):
        ns['principal'][i] += add_per
    bal = original_principal
    for i in range(n):
        if sched['interest'][i] == 0 and sched['principal'][i] == 0 and i < 10:
            bal = sched['balance'][i]
            ns['balance'][i] = bal
            ns['interest'][i] = 0
            ns['principal'][i] = 0
            continue
        prev_bal = bal if i == 0 else ns['balance'][i - 1]
        impl_rate = sched['interest'][i] / prev_bal if prev_bal > 0 else 0
        ns['interest'][i] = prev_bal * impl_rate
        ns['principal'][i] = min(prev_bal, max(0, ns['principal'][i]))
        ns['balance'][i] = prev_bal - ns['principal'][i]
        bal = ns['balance'][i]
    # Safety: bullet any residual at maturity (redistribution can leave residual when implied interest shifts)
    if n > 0 and ns['balance'][n - 1] > 0:
        extra = ns['balance'][n - 1]
        ns['principal'][n - 1] += extra
        ns['balance'][n - 1] = 0
    return {'schedule': ns, 'applied': True, 'testIdx': test_idx,
            'beforeBal': sched['balance'][test_idx], 'maxAllowed': max_allowed,
            'movedTotal': moved}


# ============================================================
# LOCKUP ESCROW
# ============================================================
def build_lockup_account(raw_equity_cf: List[float], lockup: List[int],
                          periods: List[Dict[str, Any]]) -> Dict[str, List[float]]:
    n = len(periods)
    balance = _zeros(n)
    deposits = _zeros(n)
    releases = _zeros(n)
    equity_cf_after = _zeros(n)
    bal = 0.0
    for i in range(n):
        if lockup[i]:
            if raw_equity_cf[i] > 0:
                deposits[i] = raw_equity_cf[i]
                bal += raw_equity_cf[i]
                equity_cf_after[i] = 0
            else:
                equity_cf_after[i] = raw_equity_cf[i]
        else:
            rel = bal
            releases[i] = rel
            bal = 0
            equity_cf_after[i] = raw_equity_cf[i] + rel
        balance[i] = bal
    if bal > 0 and n > 0:
        equity_cf_after[n - 1] += bal
        releases[n - 1] += bal
        balance[n - 1] = 0
    return {'balance': balance, 'deposits': deposits, 'releases': releases,
            'equityCFAfterLockup': equity_cf_after}


# ============================================================
# INSTRUMENT SCHEDULE
# ============================================================
def build_instrument_schedule(inst: Dict[str, Any], periods: List[Dict[str, Any]],
                              cfads: List[float], tifia_cfg: Optional[Dict[str, Any]],
                              ppy: int) -> Dict[str, Any]:
    n = len(periods)
    if inst['seniority'] in ('Grant', 'Equity', 'Paygo'):
        return {'interest': _zeros(n), 'principal': _zeros(n), 'balance': _zeros(n),
                'effectiveRate': 0, 'fiftyPctTest': None,
                'targetDSCR': inst.get('targetDSCR'), 'effectiveDSCR': None}
    eff_rate = inst['rate']
    if inst['type'] == 'TIFIA Loan' and tifia_cfg:
        eff_rate = tifia_all_in_rate(inst['tenorYears'], tifia_cfg)
    rate_per = eff_rate / ppy
    principal = inst.get('principalAfterIDC', inst['amount'])
    tenor_p = min(round((inst.get('tenorYears') or (n / ppy)) * ppy), n)
    io_p = round((inst.get('ioYears', 0) or 0) * ppy)
    def_p = round((inst.get('deferralYears', 0) or 0) * ppy)
    slice_periods = periods[:tenor_p]
    is_tifia_with_50 = inst['type'] == 'TIFIA Loan' and tifia_cfg and tifia_cfg.get('enforce50PctTest')
    is_sculpted = inst['repaymentStyle'] in ('Sculpted (target DSCR)', 'Deferred P&I then sculpted')
    test_info = None
    effective_dscr = None
    if is_tifia_with_50 and is_sculpted:
        io_for = 0 if inst['repaymentStyle'] == 'Deferred P&I then sculpted' else io_p
        def_for = max(1, def_p or ppy * 3) if inst['repaymentStyle'] == 'Deferred P&I then sculpted' else def_p
        tgt = inst.get('targetDSCR', 1.20) if inst['repaymentStyle'] == 'Deferred P&I then sculpted' else inst.get('targetDSCR', 1.30)
        r = sculpt_with_fifty_pct_test(principal, rate_per, slice_periods, cfads, tgt, io_for, def_for,
                                       principal, tifia_cfg.get('fiftyPercentTestYearsBeforeMaturity', 10), 0.5)
        s = r['schedule']
        test_info = r
        effective_dscr = r['effectiveDSCR']
    else:
        if inst['repaymentStyle'] == 'Level debt service':
            s = level_debt(principal, rate_per, slice_periods, io_p, def_p)
        elif inst['repaymentStyle'] == 'Equal principal':
            s = equal_principal(principal, rate_per, slice_periods, io_p, def_p)
        elif inst['repaymentStyle'] == 'Bullet':
            s = bullet(principal, rate_per, slice_periods)
        elif inst['repaymentStyle'] == 'IO then amortize':
            s = level_debt(principal, rate_per, slice_periods, max(1, io_p or ppy * 5), def_p)
        elif inst['repaymentStyle'] == 'Deferred P&I then sculpted':
            s = sculpt_to_target(principal, rate_per, slice_periods, cfads,
                                  inst.get('targetDSCR', 1.20), 0, max(1, def_p or ppy * 3))
        elif inst['repaymentStyle'] == 'Sculpted (target DSCR)':
            s = sculpt_to_target(principal, rate_per, slice_periods, cfads,
                                  inst.get('targetDSCR', 1.30), io_p, def_p)
        elif inst['repaymentStyle'] == 'Phased (multi-regime)':
            s = phased_schedule(principal, rate_per, slice_periods, cfads,
                                inst.get('phases', []), principal)
        else:
            s = level_debt(principal, rate_per, slice_periods, io_p, def_p)
        if is_tifia_with_50 and inst['repaymentStyle'] != 'Phased (multi-regime)':
            # Phased schedules are assumed to be engineered (manually or by auto-cascade) to pass the 50% test.
            # Running the post-hoc redistributor on top creates spurious bullets that conflict with the phase structure.
            r = apply_fifty_pct_test(s, slice_periods, principal,
                                      tifia_cfg.get('fiftyPercentTestYearsBeforeMaturity', 10), 0.5)
            s = r['schedule']
            test_info = r

    def pad(a):
        out = _zeros(n)
        for i, v in enumerate(a):
            if i < n:
                out[i] = v
        return out
    return {'interest': pad(s['interest']), 'principal': pad(s['principal']),
            'balance': pad(s['balance']),
            'effectiveRate': eff_rate, 'fiftyPctTest': test_info,
            'targetDSCR': inst.get('targetDSCR'), 'effectiveDSCR': effective_dscr}


# ============================================================
# LLCR, PLCR, WAL
# ============================================================
def compute_llcr(cfads: List[float], balances: List[float], periods: List[Dict[str, Any]],
                 discount_rate: float, ppy: int) -> List[Optional[float]]:
    n = len(periods)
    rate_per = discount_rate / ppy
    out = [None] * n
    for i in range(n):
        npv = 0.0
        for j in range(i + 1, n):
            npv += (cfads[j] or 0) / ((1 + rate_per) ** (j - i))
        out[i] = npv / balances[i] if balances[i] > 0 else None
    return out


compute_plcr = compute_llcr


def compute_wal(principal_by_period: List[float], periods: List[Dict[str, Any]],
                original_principal: float) -> Optional[float]:
    wt, tot, cum = 0.0, 0.0, 0.0
    for i, p in enumerate(principal_by_period):
        cum += periods[i]['yearFraction']
        mid_t = cum - periods[i]['yearFraction'] / 2
        wt += mid_t * p
        tot += p
    return wt / tot if tot > 0 else None


# ============================================================
# CONTROL ACCOUNTS, LOCKUP, IRR
# ============================================================
def build_control_accounts(model: Dict[str, Any], periods: List[Dict[str, Any]],
                           ds: List[float], opex: List[float]) -> Dict[str, List[float]]:
    ca = model['controlAccounts']
    n = len(periods)
    ppy = model['general']['periodsPerYear']
    dsra, om, ramp, mmr = _zeros(n), _zeros(n), _zeros(n), _zeros(n)
    for i in range(n):
        nads, nao = 0.0, 0.0
        for k in range(ppy):
            if i + k < n:
                nads += ds[i + k] or 0
                nao += opex[i + k] or 0
        dsra[i] = nads * (ca['dsraMonthsDS'] / 12)
        om[i] = nao * (ca['omReserveMonths'] / 12)
    rb = ca['rampUpReserveAmount']
    rel_per = ca['rampUpReserveAmount'] / max(1, ca['rampUpReleaseYears'] * ppy)
    for i in range(n):
        rb = max(0, rb - rel_per)
        ramp[i] = rb
    mb = 0.0
    cum_y = 0.0
    for i in range(n):
        cum_y += periods[i]['yearFraction']
        y = int(cum_y)
        af = 0.0
        sched = ca['mmrTargetSchedule']
        for s in reversed(sched):
            if y + 1 >= s['yearStart']:
                af = s['annualFunding']
                break
        mb += af * periods[i]['yearFraction']
        mmr[i] = mb
    return {'dsraTarget': dsra, 'omTarget': om, 'rampUp': ramp, 'mmr': mmr}


def check_lockup(senior_dscr: List[Optional[float]], llcr: List[Optional[float]],
                 tifia_cfg: Dict[str, Any], periods: List[Dict[str, Any]]) -> List[int]:
    out = _zeros(len(periods))
    for i in range(len(periods)):
        d = senior_dscr[i] is not None and senior_dscr[i] < tifia_cfg['lockupDSCR']
        ll = llcr[i] is not None and llcr[i] < tifia_cfg['lockupLLCR']
        out[i] = 1 if (d or ll) else 0
    return out


def compute_irr(flows: List[float], guess: float = 0.1) -> Optional[float]:
    r = guess
    for _ in range(200):
        npv, dnpv = 0.0, 0.0
        for t, f in enumerate(flows):
            npv += f / ((1 + r) ** t)
            dnpv += -t * f / ((1 + r) ** (t + 1))
        if abs(dnpv) < 1e-10:
            break
        new_r = r - npv / dnpv
        if not math.isfinite(new_r):
            return None
        if abs(new_r - r) < 1e-7:
            return new_r
        r = max(-0.99, min(10, new_r))
    return r


# ============================================================
# FULL MODEL ASSEMBLER
# ============================================================
def build_full_model(model: Dict[str, Any]) -> Dict[str, Any]:
    """Run the entire model. Returns a results dict with all schedules and metrics."""
    ppy = model['general'].get('periodsPerYear', 2)
    capex_sched = build_capex_schedule(model)
    cm = model['general']['constructionMonths']
    paygo_sched = build_paygo_schedule(model)
    instruments = model['financing']['instruments']
    grant_total = _sum(i['amount'] for i in instruments if i['seniority'] == 'Grant')
    equity_total = _sum(i['amount'] for i in instruments if i['seniority'] == 'Equity')
    paygo_total = paygo_sched['total']
    debt_total = _sum(i['amount'] for i in instruments if i['seniority'] not in ('Grant', 'Equity', 'Paygo'))
    sources_total = grant_total + equity_total + paygo_total + debt_total
    tifia_inst = next((i for i in instruments if i['id'] == model['tifia']['instrumentId'] and i['type'] == 'TIFIA Loan'), None)

    debt_monthly_draws = _zeros(cm)
    tifia_monthly_draws = _zeros(cm)
    for m in range(cm):
        c_m = capex_sched['monthly'][m]
        eq_share = equity_total / sources_total if sources_total > 0 else 0
        gr_share = grant_total / sources_total if sources_total > 0 else 0
        pg_share = paygo_total / sources_total if sources_total > 0 else 0
        debt_share = 1 - eq_share - gr_share - pg_share
        dd = c_m * debt_share
        debt_monthly_draws[m] = dd
        if tifia_inst and debt_total > 0:
            tifia_monthly_draws[m] = dd * (tifia_inst['amount'] / debt_total)

    if tifia_inst:
        tifia_constr = build_tifia_construction_interest(tifia_inst, tifia_monthly_draws, model['tifia'], model)
    else:
        tifia_constr = {'monthlyInterest': _zeros(cm), 'monthlyBalance': _zeros(cm),
                        'capitalizations': [], 'capitalizedInterestTotal': 0, 'finalBalance': 0}

    non_tifia_debt = debt_total - (tifia_inst['amount'] if tifia_inst else 0)
    non_tifia_rate = model['financing']['blendedIDCRateForNonTIFIA']
    nt_bal, nt_idc = 0.0, 0.0
    nt_idc_monthly = _zeros(cm)
    for m in range(cm):
        i_m = nt_bal * (non_tifia_rate / 12)
        nt_idc += i_m
        nt_idc_monthly[m] = i_m
        sh = non_tifia_debt / debt_total if debt_total > 0 else 0
        nt_bal += debt_monthly_draws[m] * sh

    financing_fees = debt_total * model['financing']['financingFeesPctOfDebt']
    if tifia_inst:
        tifia_inst['principalAfterIDC'] = tifia_inst['amount'] + tifia_constr['capitalizedInterestTotal']
    # Issuance costs per instrument, escalated from base year to FC year
    base_year = model['financing'].get('issuanceCostBaseYear', 2024)
    fc_year = int((model['general'].get('financialCloseDate') or '2026-07-01')[:4])
    years_to_fc = max(0, fc_year - base_year)
    issuance_costs_by_id = {}
    total_issuance_cost = 0
    for inst in instruments:
        base = inst.get('issuanceCost', 0) or 0
        esc = inst.get('issuanceCostEscalation', 0) or 0
        escalated = base * ((1 + esc) ** years_to_fc) if base > 0 else 0
        issuance_costs_by_id[inst['id']] = escalated
        total_issuance_cost += escalated
    total_uses = capex_sched['totalNominal'] + nt_idc + tifia_constr['capitalizedInterestTotal'] + financing_fees + total_issuance_cost

    periods = generate_operating_periods(model)
    n = len(periods)
    rev_sched = build_revenue_schedule(model, periods)
    opex_sched = build_opex_schedule(model, periods, rev_sched)
    cfads = [rev_sched['byPeriod'][i] - opex_sched['byPeriod'][i] for i in range(n)]

    senority_order = {'Short-term': 0, 'Senior': 1, 'Subordinate': 2, 'Grant': 3, 'Equity': 4, 'Paygo': 5}
    sorted_inst = sorted(instruments, key=lambda i: senority_order.get(i['seniority'], 99))
    debt_schedules = {}
    rem_cfads = list(cfads)
    for inst in sorted_inst:
        s = build_instrument_schedule(inst, periods, rem_cfads, model['tifia'], ppy)
        debt_schedules[inst['id']] = s
        for i in range(n):
            rem_cfads[i] -= (s['interest'][i] + s['principal'][i])

    senior_ds, sub_ds, short_ds = _zeros(n), _zeros(n), _zeros(n)
    senior_bal, sub_bal = _zeros(n), _zeros(n)
    senior_int, senior_pri = _zeros(n), _zeros(n)
    sub_int, sub_pri = _zeros(n), _zeros(n)
    for inst in sorted_inst:
        s = debt_schedules[inst['id']]
        for i in range(n):
            ds = s['interest'][i] + s['principal'][i]
            if inst['seniority'] == 'Senior':
                senior_ds[i] += ds; senior_bal[i] += s['balance'][i]
                senior_int[i] += s['interest'][i]; senior_pri[i] += s['principal'][i]
            elif inst['seniority'] == 'Subordinate':
                sub_ds[i] += ds; sub_bal[i] += s['balance'][i]
                sub_int[i] += s['interest'][i]; sub_pri[i] += s['principal'][i]
            elif inst['seniority'] == 'Short-term':
                short_ds[i] += ds

    total_ds = [senior_ds[i] + sub_ds[i] + short_ds[i] for i in range(n)]
    # TIFIA admin + monitoring fees per period
    tifia_admin_per_period = _zeros(n)
    tifia_monitoring_per_period = _zeros(n)
    tifia_fees_per_period = _zeros(n)
    if tifia_inst:
        admin_yr = model['tifia'].get('adminFeeAnnual', 0) or 0
        mon_bps = model['tifia'].get('monitoringFeeBps', 0) or 0
        admin_per = admin_yr / ppy
        tifia_bal = debt_schedules.get(tifia_inst['id'], {}).get('balance', _zeros(n))
        for i in range(n):
            tifia_admin_per_period[i] = admin_per
            tifia_monitoring_per_period[i] = (tifia_bal[i] * (mon_bps / 10000)) / ppy
            tifia_fees_per_period[i] = tifia_admin_per_period[i] + tifia_monitoring_per_period[i]
    # Net CFADS for DSCR (after TIFIA admin/monitoring — these are senior to debt service)
    cfads_for_dscr = [cfads[i] - tifia_fees_per_period[i] for i in range(n)]
    senior_dscr = [(cfads_for_dscr[i] / senior_ds[i]) if senior_ds[i] > 0 else None for i in range(n)]
    total_dscr = [(cfads_for_dscr[i] / total_ds[i]) if total_ds[i] > 0 else None for i in range(n)]
    overall_obl = [(rev_sched['byPeriod'][i] / (opex_sched['byPeriod'][i] + total_ds[i]))
                   if (opex_sched['byPeriod'][i] + total_ds[i]) > 0 else None for i in range(n)]
    overall_passes = [v is not None and v >= model['waterfall']['overallObligationMin'] for v in overall_obl]

    llcr_senior = compute_llcr(cfads, senior_bal, periods, model['general']['discountRate'], ppy)
    plcr_senior = compute_plcr(cfads, senior_bal, periods, model['general']['discountRate'], ppy)
    wal_by_instrument = {inst['id']: compute_wal(debt_schedules[inst['id']]['principal'], periods,
                                                  inst.get('principalAfterIDC', inst['amount']))
                         for inst in sorted_inst}

    lockup = check_lockup(senior_dscr, llcr_senior, model['tifia'], periods)
    control_accts = build_control_accounts(model, periods, total_ds, opex_sched['byPeriod'])

    raw_equity_cf = _zeros(n)
    for i in range(n):
        if model['waterfall']['mode'] == 'Debt-first (Revenue \u2192 DS \u2192 Opex)':
            raw_equity_cf[i] = rev_sched['byPeriod'][i] - total_ds[i] - opex_sched['byPeriod'][i] - tifia_fees_per_period[i]
        else:
            raw_equity_cf[i] = cfads_for_dscr[i] - total_ds[i]

    lockup_acct = build_lockup_account(raw_equity_cf, lockup, periods)
    equity_cf = lockup_acct['equityCFAfterLockup']

    equity_flows = [-equity_total - paygo_total] + list(equity_cf)
    equity_irr = compute_irr(equity_flows)

    constr_years = math.ceil(cm / 12)
    proj_flows = [-_sum(capex_sched['monthly'][y * 12:min(cm, (y + 1) * 12)]) for y in range(constr_years)]
    annual_cfads = []
    cum_y, bucket, bucket_y = 0.0, 0.0, 0
    for i in range(n):
        bucket += cfads[i]
        cum_y += periods[i]['yearFraction']
        if cum_y >= bucket_y + 1 or i == n - 1:
            annual_cfads.append(bucket)
            bucket = 0
            bucket_y = int(cum_y)
    project_irr = compute_irr(proj_flows + annual_cfads)

    finite_d = [v for v in senior_dscr if v is not None and math.isfinite(v)]
    finite_l = [v for v in llcr_senior if v is not None and math.isfinite(v)]

    return {
        'periods': periods,
        'capex_sched': capex_sched, 'paygo_sched': paygo_sched, 'tifia_constr': tifia_constr,
        'non_tifia_idc': nt_idc, 'non_tifia_idc_monthly': nt_idc_monthly, 'financing_fees': financing_fees,
        'capitalized_tifia_interest': tifia_constr['capitalizedInterestTotal'],
        'total_uses': total_uses, 'total_sources': sources_total,
        'total_issuance_cost': total_issuance_cost,
        'issuance_costs_by_id': issuance_costs_by_id,
        'tifia_admin_per_period': tifia_admin_per_period,
        'tifia_monitoring_per_period': tifia_monitoring_per_period,
        'tifia_fees_per_period': tifia_fees_per_period,
        'total_tifia_fees': _sum(tifia_fees_per_period),
        'cfads_for_dscr': cfads_for_dscr,
        'grant_total': grant_total, 'equity_total': equity_total, 'paygo_total': paygo_total, 'debt_total': debt_total,
        'rev_sched': rev_sched, 'opex_sched': opex_sched, 'cfads_by_period': cfads,
        'instruments': sorted_inst, 'debt_schedules': debt_schedules,
        'senior_ds': senior_ds, 'sub_ds': sub_ds, 'short_ds': short_ds, 'total_ds': total_ds,
        'senior_bal': senior_bal, 'sub_bal': sub_bal,
        'senior_int': senior_int, 'senior_pri': senior_pri, 'sub_int': sub_int, 'sub_pri': sub_pri,
        'senior_dscr': senior_dscr, 'total_dscr': total_dscr,
        'llcr_senior': llcr_senior, 'plcr_senior': plcr_senior,
        'wal_by_instrument': wal_by_instrument,
        'overall_obligation': overall_obl, 'overall_passes': overall_passes,
        'lockup': lockup, 'lockup_acct': lockup_acct, 'raw_equity_cf': raw_equity_cf,
        'control_accts': control_accts, 'equity_cf': equity_cf,
        'equity_irr': equity_irr, 'project_irr': project_irr,
        'min_senior_dscr': min(finite_d) if finite_d else None,
        'avg_senior_dscr': sum(finite_d) / len(finite_d) if finite_d else None,
        'min_llcr': min(finite_l) if finite_l else None,
        'tifia_all_in_rate': tifia_all_in_rate(tifia_inst['tenorYears'], model['tifia']) if tifia_inst else None,
        'tifia_50_test': debt_schedules[tifia_inst['id']]['fiftyPctTest'] if tifia_inst else None,
        'tifia_effective_dscr': debt_schedules[tifia_inst['id']]['effectiveDSCR'] if tifia_inst else None,
        'tifia_target_dscr': tifia_inst.get('targetDSCR') if tifia_inst else None,
    }


# ============================================================
# OPTIMIZERS
# ============================================================
def optimize_instrument(model: Dict[str, Any], target_id: str,
                         constraints: Dict[str, Any]) -> Dict[str, Any]:
    lo, hi = 1_000_000, 2_000_000_000
    best = lo
    best_results = None

    def check(r):
        if constraints.get('minSeniorDSCR') and r['min_senior_dscr'] is not None and r['min_senior_dscr'] < constraints['minSeniorDSCR']:
            return False
        if constraints.get('minTotalDSCR'):
            f = [v for v in r['total_dscr'] if v is not None and math.isfinite(v)]
            if f and min(f) < constraints['minTotalDSCR']:
                return False
        if constraints.get('minLLCR') and r['min_llcr'] is not None and r['min_llcr'] < constraints['minLLCR']:
            return False
        if constraints.get('minPLCR'):
            f = [v for v in r['plcr_senior'] if v is not None and math.isfinite(v)]
            if f and min(f) < constraints['minPLCR']:
                return False
        if constraints.get('enforceOverallObligation') and any(v is False for v in r['overall_passes']):
            return False
        return True

    iterations = []
    for it in range(40):
        mid = (lo + hi) / 2
        m = copy.deepcopy(model)
        target = next((i for i in m['financing']['instruments'] if i['id'] == target_id), None)
        if not target:
            return {'error': 'instrument not found'}
        target['amount'] = mid
        r = build_full_model(m)
        ok = check(r)
        iterations.append({'iter': it, 'amount': mid, 'ok': ok,
                           'min_dscr': r['min_senior_dscr'], 'min_llcr': r['min_llcr']})
        if ok:
            best = mid
            best_results = r
            lo = mid
        else:
            hi = mid
        if hi - lo < 100_000:
            break
    return {'best': best, 'best_results': best_results, 'iterations': iterations}


def optimize_joint_tranches(model: Dict[str, Any], targets: List[Dict[str, Any]],
                             shared_constraints: Dict[str, Any],
                             plug_instrument_id: str,
                             max_outer_iter: int = 8) -> Dict[str, Any]:
    """True iterative joint sizing. Sizes each tranche, plugs gap, re-sizes until convergence."""
    working = copy.deepcopy(model)
    sen_order = {'Senior': 0, 'Subordinate': 1, 'Short-term': 2, 'Equity': 3, 'Grant': 4, 'Paygo': 5}
    ordered = sorted(targets, key=lambda t: sen_order.get(
        next((i['seniority'] for i in working['financing']['instruments'] if i['id'] == t['instrumentId']), 'Equity'), 99))
    outer_history = []
    converged = False
    prev_gap = None
    total_plug_adj = 0.0
    for outer in range(max_outer_iter):
        inner = []
        for tgt in ordered:
            inst = next((i for i in working['financing']['instruments'] if i['id'] == tgt['instrumentId']), None)
            if not inst:
                inner.append({'instrumentId': tgt['instrumentId'], 'error': 'not found'})
                continue
            c = dict(shared_constraints)
            if inst['seniority'] == 'Senior':
                c['minSeniorDSCR'] = tgt.get('minDSCR', shared_constraints.get('minSeniorDSCR'))
            elif inst['seniority'] == 'Subordinate':
                c['minTotalDSCR'] = tgt.get('minDSCR', shared_constraints.get('minTotalDSCR'))
            c['minLLCR'] = tgt.get('minLLCR', shared_constraints.get('minLLCR'))
            r = optimize_instrument(working, tgt['instrumentId'], c)
            old_amt = inst['amount']
            if r.get('best'):
                inst['amount'] = round(r['best'])
            inner.append({'instrumentId': tgt['instrumentId'], 'seniority': inst['seniority'],
                          'oldAmt': old_amt, 'newAmt': inst['amount'],
                          'iterations': len(r.get('iterations', []))})
        pre_r = build_full_model(working)
        gap = pre_r['total_uses'] - pre_r['total_sources']
        plug_adj = 0.0
        if plug_instrument_id:
            plug = next((i for i in working['financing']['instruments'] if i['id'] == plug_instrument_id), None)
            if plug:
                new_amt = max(0, plug['amount'] + gap)
                plug_adj = new_amt - plug['amount']
                plug['amount'] = round(new_amt)
                total_plug_adj += plug_adj
        post_r = build_full_model(working)
        post_gap = post_r['total_uses'] - post_r['total_sources']
        outer_history.append({'outerIter': outer + 1, 'inner': inner, 'preGap': gap,
                              'plugAdjustment': plug_adj, 'postGap': post_gap,
                              'min_senior_dscr': post_r['min_senior_dscr'],
                              'min_llcr': post_r['min_llcr']})
        if abs(post_gap) < 100_000:
            converged = True
            break
        if prev_gap is not None and abs(gap - prev_gap) < 50_000:
            converged = True
            break
        prev_gap = gap
    final = build_full_model(working)
    return {'working_model': working, 'outer_history': outer_history,
            'final_results': final, 'final_gap': final['total_uses'] - final['total_sources'],
            'converged': converged, 'outer_iterations': len(outer_history),
            'total_plug_adjustment': total_plug_adj}


# ============================================================
# AUTO-CASCADE TIFIA (50% TEST PASSES BY CONSTRUCTION)
# ============================================================
def build_tifia_cascade_phases(model: Dict[str, Any], instrument_id: str,
                                params: Dict[str, Any],
                                cfads_by_period: List[float]) -> Dict[str, Any]:
    """Generate a 4-phase TIFIA schedule that passes the 50% test by construction.

    Phases: defer / IO / sculpt-or-annuity-to-50% / level-to-zero
    Returns {'phases': [...], 'test_point', 'diagnosis', 'fallback_used', 'found_dscr', ...}
    """
    inst = next((i for i in model['financing']['instruments'] if i['id'] == instrument_id), None)
    if not inst:
        return {'error': 'TIFIA instrument not found', 'phases': []}
    ppy = model['general']['periodsPerYear']
    tenor_periods = round(inst['tenorYears'] * ppy)
    defer_p = round((params.get('deferYears', 0) or 0) * ppy)
    io_p = round((params.get('ioYears', 0) or 0) * ppy)
    test_p = round((params.get('testYearsBeforeMaturity', 10) or 10) * ppy)
    phase3_end = tenor_periods - test_p
    phase4_end = tenor_periods
    phase3_periods = phase3_end - defer_p - io_p
    if phase3_periods <= 0:
        return {'error': 'Phase 3 has no periods (check defer/IO/test years vs tenor)', 'phases': []}

    P = inst['amount']
    # Use TIFIA all-in rate (treasury + spread)
    rate_per = tifia_all_in_rate(inst['tenorYears'], model['tifia']) / ppy
    post_io_bal = P * (1 + rate_per) ** defer_p  # IO doesn't change balance
    target_test_bal = 0.5 * P

    phases = []
    if defer_p > 0: phases.append({'regime': 'defer', 'endPeriod': defer_p, 'targetDSCR': None})
    if io_p > 0:    phases.append({'regime': 'io',    'endPeriod': defer_p + io_p, 'targetDSCR': None})

    fallback_used = False
    found_dscr = None
    diagnosis = ''

    if params.get('phase3Mode') in ('annuity', 'level'):
        phases.append({'regime': 'level', 'endPeriod': phase3_end, 'targetEndBalance': target_test_bal})
        diagnosis = 'Phase 3 annuity (level pmt to 50% balance)'
    else:
        # Sculpt mode — binary search DSCR
        cfads_slice = []
        for i in range(defer_p + io_p, phase3_end):
            cfads_slice.append(cfads_by_period[i] if i < len(cfads_by_period) else 0)

        def simulate(dscr):
            bal = post_io_bal
            for i in range(len(cfads_slice)):
                int_p = bal * rate_per
                max_ds = cfads_slice[i] / max(dscr, 0.0001)
                pri = max(0, min(bal, max_ds - int_p))
                bal -= pri
            return bal

        bal_max_amort = simulate(1.0001)
        if bal_max_amort > target_test_bal:
            phases.append({'regime': 'level', 'endPeriod': phase3_end, 'targetEndBalance': target_test_bal, '_fallback': 'sculpt-infeasible'})
            fallback_used = True
            diagnosis = f'Sculpt infeasible (TIFIA too large for CFADS) — fell back to annuity. Max amort balance ${bal_max_amort/1e6:.1f}M > target 50% ${target_test_bal/1e6:.1f}M.'
        else:
            lo, hi = 1.0001, 200.0
            for _ in range(60):
                mid = (lo + hi) / 2
                bal = simulate(mid)
                if bal > target_test_bal:
                    hi = mid
                else:
                    lo = mid
                if hi - lo < 0.0005:
                    break
            found_dscr = (lo + hi) / 2
            phases.append({'regime': 'sculpt', 'endPeriod': phase3_end, 'targetDSCR': found_dscr})
            diagnosis = f'Phase 3 sculpt @ DSCR {found_dscr:.3f}x (solved to hit 50% test balance)'

    phases.append({'regime': 'level', 'endPeriod': phase4_end, 'targetEndBalance': 0})

    return {
        'phases': phases,
        'test_point': phase3_end - 1,
        'post_io_balance': post_io_bal,
        'target_test_balance': target_test_bal,
        'fallback_used': fallback_used,
        'found_dscr': found_dscr,
        'diagnosis': diagnosis,
    }


def auto_cascade_tifia(model: Dict[str, Any], params: Dict[str, Any]) -> Dict[str, Any]:
    """TIFIA-FIRST cascade optimizer.

    Logic:
      1. TIFIA = min(49% x eligible, max % where 50% test passes AND min Total DSCR >= floor)
         - Total DSCR = CFADS_net / (Sr DS + TIFIA DS)
         - TIFIA effective DSCR >= floor as secondary check
      2. PAB = min(remaining funding need, max where (CFADS_net - TIFIA DS) / Sr DS >= Sr DSCR floor)
         - Sized AFTER TIFIA so TIFIA gets priority on cheap senior-equivalent capacity
      3. Equity = min(remaining funding need, NPV of distributable CF @ target IRR) — set externally
      4. Grant = plug
    CFADS_net = CFADS - TIFIA admin/monitoring fees.

    Returns {'best': {...}, 'trace': [...], 'converged': bool}
    """
    working = copy.deepcopy(model)
    trace = []

    def evaluate(pct):
        w = copy.deepcopy(working)
        try:
            temp_r = build_full_model(w)
        except Exception as e:
            return {'pct': pct, 'error': f'init build failed: {e}', 'feasible': False}

        # ---- STEP 1: SIZE TIFIA ----
        eligible_cost = 0
        for cid in (params.get('tifiaEligibleCapexIds') or []):
            eligible_cost += _sum(temp_r['capex_sched']['byItem'].get(cid, []))
        tifia_amount = round(eligible_cost * pct)
        tifia = next((i for i in w['financing']['instruments'] if i['id'] == params.get('tifiaInstrumentId')), None)
        if not tifia:
            return {'pct': pct, 'error': 'TIFIA not found', 'feasible': False}
        tifia['amount'] = tifia_amount

        # Temporarily zero PAB so TIFIA gets first shot at the structure
        pab_inst = next((i for i in w['financing']['instruments']
                         if i['id'] == params.get('pabInstrumentId')), None) if params.get('pabInstrumentId') else None
        if pab_inst:
            pab_inst['amount'] = 0

        pre_r = build_full_model(w)
        # CFADS available to TIFIA = full CFADS_for_DSCR (after admin fees) since no PAB yet
        cfads_for_tifia = list(pre_r['cfads_for_dscr'])

        # Build TIFIA phases that pass 50% test by construction, sculpted against TIFIA-available CFADS
        phase_res = build_tifia_cascade_phases(w, params['tifiaInstrumentId'], {
            'deferYears': params.get('deferYears'),
            'ioYears': params.get('ioYears'),
            'testYearsBeforeMaturity': params.get('testYearsBeforeMaturity'),
            'phase3Mode': params.get('phase3Mode'),
        }, cfads_for_tifia)
        if 'error' in phase_res:
            return {'pct': pct, 'tifiaAmount': tifia_amount, 'error': phase_res['error'], 'feasible': False}
        tifia['phases'] = phase_res['phases']
        tifia['repaymentStyle'] = 'Phased (multi-regime)'

        # ---- STEP 2: SIZE PAB ----
        # PAB only if TIFIA hit statutory ceiling (49%) AND funding gap remains
        # Constraint: PAB = min(funding gap, max PAB where (CFADS - TIFIA DS)/Sr DS >= Sr DSCR floor)
        pab_amount = 0
        max_tifia_pct = params.get('maxTifiaPct', 0.49)
        tifia_at_ceiling = pct >= max_tifia_pct - 0.005
        if pab_inst:
            if not tifia_at_ceiling:
                # TIFIA stopped below ceiling — adding PAB hurts Total DSCR. No PAB.
                pab_inst['amount'] = 0
                pab_amount = 0
            else:
                # TIFIA at ceiling — check if funding gap remains with PAB=0
                pab_inst['amount'] = 0
                try:
                    gap_r = build_full_model(w)
                    funding_gap = gap_r['total_uses'] - gap_r['total_sources']
                except Exception:
                    funding_gap = 0
                if funding_gap <= 0:
                    pab_amount = 0  # no gap, no PAB needed
                else:
                    # Find max PAB at Sr DSCR floor, then cap at funding_gap
                    tifia_sched = gap_r['debt_schedules'].get(tifia['id'], {})
                    tifia_ds = [(tifia_sched.get('interest', _zeros(len(gap_r['periods'])))[i] +
                                 tifia_sched.get('principal', _zeros(len(gap_r['periods'])))[i])
                                for i in range(len(gap_r['periods']))]
                    min_sr_dscr_floor = params.get('minSrDSCR', 1.30)

                    def pab_feasible(amt):
                        pab_inst['amount'] = round(amt)
                        try:
                            rr = build_full_model(w)
                        except Exception:
                            return False, None
                        sr_ds = rr['senior_ds']
                        worst = float('inf')
                        for j in range(len(rr['periods'])):
                            if tifia_ds[j] > 1000 and sr_ds[j] > 1000:
                                d = (rr['cfads_for_dscr'][j] - tifia_ds[j]) / sr_ds[j]
                                if d < worst:
                                    worst = d
                        if worst == float('inf'):
                            worst = 999
                        return (worst >= min_sr_dscr_floor - 0.005), worst

                    # Binary search up to funding gap (no need to go higher)
                    lo, hi = 0.0, funding_gap * 1.1
                    max_at_floor = 0
                    for _ in range(40):
                        m = (lo + hi) / 2
                        ok, _ = pab_feasible(m)
                        if ok:
                            max_at_floor = m
                            lo = m
                        else:
                            hi = m
                        if hi - lo < 50_000:
                            break
                    pab_amount = min(funding_gap, max_at_floor)
                    pab_inst['amount'] = round(pab_amount)

        # ---- STEP 3: SIZE EQUITY TO TARGET IRR ----
        # Binary search equity such that actual equity IRR (from engine) = target.
        # More equity → lower IRR; less equity → higher IRR.
        # Find max equity that still achieves IRR ≥ target. Plug-grant fills any residual gap.
        equity_amount = None
        equity_for_irr_calc = None
        target_irr = params.get('targetEquityIRR', 0.12) or 0
        equity_inst_id = params.get('equityInstrumentId')
        if equity_inst_id and target_irr > 0:
            equity_inst = next((i for i in w['financing']['instruments'] if i['id'] == equity_inst_id), None)
            if equity_inst:
                try:
                    eq_pre = build_full_model(w)
                except Exception:
                    eq_pre = None
                if eq_pre is not None:
                    # Funding gap excluding current equity = upper bound for equity sizing
                    other_sources = eq_pre['total_sources'] - equity_inst['amount']
                    gap_no_eq = max(0, eq_pre['total_uses'] - other_sources)
                    # Binary search: find max equity where IRR ≥ target
                    lo_eq, hi_eq = 0.0, gap_no_eq * 1.5  # 1.5x just in case target IRR low
                    equity_amount = 0
                    for _ in range(30):
                        mid = (lo_eq + hi_eq) / 2
                        equity_inst['amount'] = round(mid)
                        try:
                            test_r = build_full_model(w)
                            actual_irr = test_r.get('equity_irr')
                            if actual_irr is None:
                                actual_irr = -1
                        except Exception:
                            actual_irr = -1
                        if actual_irr >= target_irr - 0.0001:
                            equity_amount = mid
                            lo_eq = mid
                        else:
                            hi_eq = mid
                        if hi_eq - lo_eq < 10_000:
                            break
                    # Cap at funding gap (don't over-fund)
                    equity_amount = min(equity_amount, gap_no_eq)
                    equity_for_irr_calc = equity_amount
                    equity_inst['amount'] = round(equity_amount)

        # ---- STEP 4: PLUG (grants fill any remaining gap) ----
        try:
            final_r = build_full_model(w)
        except Exception as e:
            return {'pct': pct, 'tifiaAmount': tifia_amount, 'error': f'final build failed: {e}', 'feasible': False}
        plug_applied = 0
        if params.get('plugInstrumentId'):
            gap = final_r['total_uses'] - final_r['total_sources']
            plug = next((i for i in w['financing']['instruments'] if i['id'] == params['plugInstrumentId']), None)
            if plug:
                plug['amount'] = max(0, round(plug['amount'] + gap))
                plug_applied = gap
                try:
                    final_r = build_full_model(w)
                except Exception:
                    pass

        # ---- FEASIBILITY ----
        # Feasibility floors measured ONLY over TIFIA-active periods (excludes RAN bullet etc.)
        # Display values fall back to all-period min when TIFIA-active periods have no senior DS.
        tifia_sched = final_r.get('debt_schedules', {}).get(params['tifiaInstrumentId'])
        min_sr_dscr_feas = float('inf')   # for feasibility check
        min_total_dscr = float('inf')
        min_tifia_eff = float('inf')
        if tifia_sched:
            for i in range(len(final_r['periods'])):
                t_ds = (tifia_sched['interest'][i] or 0) + (tifia_sched['principal'][i] or 0)
                if t_ds > 1000:
                    sr_ds_i = final_r['senior_ds'][i] or 0
                    sub_ds_i = final_r['sub_ds'][i] or 0
                    cf_i = final_r['cfads_for_dscr'][i] or 0
                    if sr_ds_i > 1000:
                        sr_dscr = cf_i / sr_ds_i
                        if sr_dscr < min_sr_dscr_feas: min_sr_dscr_feas = sr_dscr
                    td = sr_ds_i + sub_ds_i
                    if td > 1000:
                        if cf_i / td < min_total_dscr: min_total_dscr = cf_i / td
                    eff = (cf_i - sr_ds_i) / t_ds
                    if eff < min_tifia_eff: min_tifia_eff = eff

        # For display: prefer the TIFIA-active value; fall back to all-period min when no senior DS overlaps TIFIA
        if min_sr_dscr_feas != float('inf'):
            min_sr_dscr = min_sr_dscr_feas
        else:
            all_sr = [v for v in (final_r.get('senior_dscr') or []) if v is not None and math.isfinite(v)]
            min_sr_dscr = min(all_sr) if all_sr else 999
        if min_total_dscr == float('inf'): min_total_dscr = None
        if min_tifia_eff == float('inf'): min_tifia_eff = None
        # Feasibility uses the TIFIA-active value (or 999 if no overlap → vacuously feasible)
        sr_for_feas = min_sr_dscr_feas if min_sr_dscr_feas != float('inf') else 999

        test_bal = (tifia_sched['balance'][phase_res['test_point']]
                    if phase_res.get('test_point', -1) >= 0 and tifia_sched else None)
        test_passed = test_bal is not None and test_bal <= 0.5 * tifia_amount + 1000

        feasible = (
            (min_total_dscr is None or min_total_dscr >= (params.get('minTotalDSCR', 1.10) - 0.005))
            and (min_tifia_eff is None or min_tifia_eff >= (params.get('minTifiaDSCR', 1.10) - 0.005))
            and (sr_for_feas >= (params.get('minSrDSCR', 1.30) - 0.005))
            and test_passed
        )

        return {
            'pct': pct, 'tifiaAmount': tifia_amount, 'pabAmount': round(pab_amount) if pab_amount else 0,
            'equityAmount': round(equity_amount) if equity_amount else 0,
            'equityForIRRCalc': round(equity_for_irr_calc) if equity_for_irr_calc else 0,
            'actualEquityIRR': final_r.get('equity_irr'),
            'targetEquityIRR': target_irr,
            'eligibleCost': eligible_cost, 'phaseInfo': phase_res,
            'minSrDSCR': min_sr_dscr, 'minTotalDSCR': min_total_dscr, 'minTifiaEffDSCR': min_tifia_eff,
            'testBalAtPoint': test_bal, 'testPassed': test_passed,
            'finalGap': final_r['total_uses'] - final_r['total_sources'],
            'plugApplied': plug_applied, 'feasible': feasible,
            'workingModel': w, 'finalResults': final_r,
        }

    lo = params.get('minTifiaPct', 0.10)
    hi = params.get('maxTifiaPct', 0.49)
    best = None

    # Start from ceiling — TIFIA is cheap, push it
    e_hi = evaluate(hi)
    e_hi['iter'] = 1
    trace.append(e_hi)
    if e_hi.get('feasible'):
        return {'best': e_hi, 'trace': trace, 'converged': True, 'ceiling_reached': True}

    e_lo = evaluate(lo)
    e_lo['iter'] = 2
    trace.append(e_lo)
    if not e_lo.get('feasible'):
        return {'best': None, 'trace': trace, 'converged': False,
                'error': 'Even min TIFIA % infeasible — relax constraints'}
    best = e_lo

    for it in range(18):
        mid = (lo + hi) / 2
        r = evaluate(mid)
        r['iter'] = len(trace) + 1
        trace.append(r)
        if r.get('feasible'):
            best = r
            lo = mid
        else:
            hi = mid
        if hi - lo < 0.003:
            break
    return {'best': best, 'trace': trace, 'converged': True}





# ============================================================
# CONVENIENCE: sensitivity grid
# ============================================================
SHOCK_FNS = {
    'aadt':     lambda m, v: m['revenue'].__setitem__('aadtY1', m['revenue']['aadtY1'] * (1 + v)),
    'toll':     lambda m, v: [c.__setitem__('toll', c['toll'] * (1 + v)) for c in m['revenue']['vehicleClasses']],
    'opex':     lambda m, v: [i.__setitem__('base', i['base'] * (1 + v)) for i in m['opex']['items']],
    'capex':    lambda m, v: [i.__setitem__('base', i['base'] * (1 + v)) for i in m['capex']['items']],
    'treasury': lambda m, v: m['tifia'].__setitem__('treasuryRate', m['tifia']['treasuryRate'] + v / 10000),
    'discount': lambda m, v: m['general'].__setitem__('discountRate', m['general']['discountRate'] + v / 10000),
}


def sensitivity_grid(model: Dict[str, Any], x_var: str, x_vals: List[float],
                     y_var: str, y_vals: List[float],
                     metric_fn: Callable[[Dict[str, Any]], Optional[float]]) -> List[List[Optional[float]]]:
    """Run a 2D sensitivity grid. Returns rows=y, cols=x."""
    grid = []
    for yv in y_vals:
        row = []
        for xv in x_vals:
            m = copy.deepcopy(model)
            SHOCK_FNS[x_var](m, xv)
            if y_var != x_var:
                SHOCK_FNS[y_var](m, yv)
            try:
                r = build_full_model(m)
                row.append(metric_fn(r))
            except Exception:
                row.append(None)
        grid.append(row)
    return grid


# ============================================================
# VALUE FOR MONEY (VfM) ANALYSIS
# ============================================================
# PSC vs P3 NPV comparison from the public sector's perspective.
# PSC retains 100% of risks; P3 retains only the contractually-public share.
# Both NPVs are taken at the PSC (government) discount rate.

def compute_risk_expected_impact(risk: Dict[str, Any]) -> float:
    """PERT mean: (low + 4*most_likely + high) / 6 — robust against tail bias."""
    return ((risk.get('impactLow') or 0)
            + 4 * (risk.get('impactMostLikely') or 0)
            + (risk.get('impactHigh') or 0)) / 6


def npv_annuity(annual: float, years: int, rate: float, start_delay_years: float = 0) -> float:
    """PV of an annuity of `annual` for `years`, delayed by `start_delay_years`."""
    if years <= 0:
        return 0.0
    pv = annual * years if rate == 0 else annual * (1 - (1 + rate) ** -years) / rate
    return pv / ((1 + rate) ** start_delay_years)


def build_vfm_analysis(model: Dict[str, Any],
                        results: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Compute Value-for-Money: PSC vs P3 net cost NPVs.

    If `results` is None, runs build_full_model first.

    Returns dict with: psc_net_cost, p3_net_cost, vfm, vfm_pct, full PSC/P3 build-ups,
    enriched risk register (per-risk EV / public+private split), and risk subtotals.
    """
    if results is None:
        results = build_full_model(model)

    v = model['vfm']
    rate = v.get('pscDiscountRate', 0.045)
    const_yrs = math.ceil(model['general']['constructionMonths'] / 12)
    ops_yrs = model['general']['operationsYears']

    # Aggregate capex by construction year (mid-year discounting)
    annual_capex = []
    for y in range(const_yrs):
        sm, em = y * 12, min(model['general']['constructionMonths'], (y + 1) * 12)
        annual_capex.append(_sum(results['capex_sched']['monthly'][sm:em]))

    # Aggregate ops opex and revenue by operations year
    annual_opex, annual_revenue = [], []
    bucket_y, cum_y, bucket_opex, bucket_rev = 0, 0.0, 0.0, 0.0
    for i, p in enumerate(results['periods']):
        bucket_opex += results['opex_sched']['byPeriod'][i]
        bucket_rev += results['rev_sched']['byPeriod'][i]
        cum_y += p['yearFraction']
        if cum_y >= bucket_y + 1 or i == len(results['periods']) - 1:
            annual_opex.append(bucket_opex)
            annual_revenue.append(bucket_rev)
            bucket_opex, bucket_rev = 0.0, 0.0
            bucket_y = int(cum_y)

    constr_risks = [r for r in v['riskRegister'] if r.get('phase') == 'construction']
    ops_risks = [r for r in v['riskRegister'] if r.get('phase') == 'operations']

    def enrich(r):
        pert_pre = compute_risk_expected_impact(r)
        ev_pre = (r.get('probability') or 0) * pert_pre
        p_red = r.get('probReduction') or 0
        i_red = r.get('impactReduction') or 0
        post_r = {**r,
                  'probability': (r.get('probability') or 0) * (1 - p_red),
                  'impactLow': (r.get('impactLow') or 0) * (1 - i_red),
                  'impactMostLikely': (r.get('impactMostLikely') or 0) * (1 - i_red),
                  'impactHigh': (r.get('impactHigh') or 0) * (1 - i_red)}
        pert_post = compute_risk_expected_impact(post_r)
        ev_post = post_r['probability'] * pert_post
        priv_share = r.get('shareToPrivate', 0) or 0
        mc = r.get('mitigationCost') or 0
        owner = r.get('mitigationOwner') or 'public'
        mit_pub = mc if owner == 'public' else (mc * 0.5 if owner == 'shared' else 0)
        mit_priv = mc if owner == 'private' else (mc * 0.5 if owner == 'shared' else 0)
        return {**r, 'pertMean': pert_pre, 'expectedValue': ev_pre,
                'evPostMit': ev_post, 'mitigationBenefit': ev_pre - ev_post,
                'publicEV': ev_pre * (1 - priv_share), 'privateEV': ev_pre * priv_share,
                'publicEVPost': ev_post * (1 - priv_share), 'privateEVPost': ev_post * priv_share,
                'mitCostPublic': mit_pub, 'mitCostPrivate': mit_priv, 'mitCostTotal': mc}

    cr = [enrich(r) for r in constr_risks]
    or_ = [enrich(r) for r in ops_risks]
    # Pre-mit totals (for reference)
    total_constr_ev_pre = sum(r['expectedValue'] for r in cr)
    annual_ops_ev_pre = sum(r['expectedValue'] for r in or_)
    # Post-mit totals (what actually feeds VfM)
    total_constr_ev = sum(r['evPostMit'] for r in cr)
    public_constr_ev = sum(r['publicEVPost'] for r in cr)
    private_constr_ev = total_constr_ev - public_constr_ev
    annual_ops_ev = sum(r['evPostMit'] for r in or_)
    annual_public_ops_ev = sum(r['publicEVPost'] for r in or_)
    annual_private_ops_ev = annual_ops_ev - annual_public_ops_ev
    # Mitigation cost totals + NPVs
    total_constr_mit_cost = sum(r['mitCostTotal'] for r in cr)
    public_constr_mit_cost = sum(r['mitCostPublic'] for r in cr)
    annual_ops_mit_cost = sum(r['mitCostTotal'] for r in or_)
    public_ops_mit_cost = sum(r['mitCostPublic'] for r in or_)
    total_constr_mit_npv = total_constr_mit_cost / (1 + rate) ** (const_yrs / 2)
    public_constr_mit_npv = public_constr_mit_cost / (1 + rate) ** (const_yrs / 2)
    total_ops_mit_npv = npv_annuity(annual_ops_mit_cost, ops_yrs, rate, const_yrs)
    public_ops_mit_npv = npv_annuity(public_ops_mit_cost, ops_yrs, rate, const_yrs)

    # PSC build-up
    psc_prem = 1 + v.get('pscCostPremium', 0)
    psc_capex_npv = sum(annual_capex[y] * psc_prem / (1 + rate) ** (y + 0.5)
                         for y in range(const_yrs))
    psc_opex_npv = sum((annual_opex[y] if y < len(annual_opex) else 0) * psc_prem
                        / (1 + rate) ** (const_yrs + y + 0.5)
                        for y in range(ops_yrs))
    psc_constr_risk_npv = total_constr_ev / (1 + rate) ** (const_yrs / 2)
    psc_ops_risk_npv = npv_annuity(annual_ops_ev, ops_yrs, rate, const_yrs)
    psc_revenue_npv = sum(((annual_revenue[y] if y < len(annual_revenue) else 0) or 0)
                          / (1 + rate) ** (const_yrs + y + 0.5)
                          for y in range(ops_yrs))
    comp_neutrality_adj = (psc_capex_npv + psc_opex_npv) * v.get('competitiveNeutralityPct', 0)
    psc_net_cost = (psc_capex_npv + psc_opex_npv + psc_constr_risk_npv
                    + psc_ops_risk_npv + total_constr_mit_npv + total_ops_mit_npv
                    + comp_neutrality_adj - psc_revenue_npv)

    # P3 build-up (public perspective)
    p3_public_constr_risk_npv = public_constr_ev / (1 + rate) ** (const_yrs / 2)
    p3_public_ops_risk_npv = npv_annuity(annual_public_ops_ev, ops_yrs, rate, const_yrs)

    if v.get('isAvailabilityBased'):
        availability_npv = sum(
            v['availabilityPaymentAnnual'] * (1 + v['availabilityEscalation']) ** y
            / (1 + rate) ** (v.get('availabilityStartYear', 0) + y + 0.5)
            for y in range(v['availabilityYears'])
        )
        p3_net_cost = (availability_npv + p3_public_constr_risk_npv + p3_public_ops_risk_npv
                       + public_constr_mit_npv + public_ops_mit_npv)
        p3_components = {'availabilityNPV': availability_npv,
                         'p3PublicConstrRiskNPV': p3_public_constr_risk_npv,
                         'p3PublicOpsRiskNPV': p3_public_ops_risk_npv,
                         'publicConstrMitNPV': public_constr_mit_npv,
                         'publicOpsMitNPV': public_ops_mit_npv}
    else:
        upfront_fee = v.get('upfrontConcessionFee', 0)
        rev_share = v.get('revenueSharePct', 0)
        foregone_rev_npv = sum(((annual_revenue[y] if y < len(annual_revenue) else 0) or 0)
                                * (1 - rev_share)
                                / (1 + rate) ** (const_yrs + y + 0.5)
                                for y in range(ops_yrs))
        p3_net_cost = (foregone_rev_npv + p3_public_constr_risk_npv
                       + p3_public_ops_risk_npv + public_constr_mit_npv
                       + public_ops_mit_npv - upfront_fee)
        p3_components = {'foregoneRevNPV': foregone_rev_npv, 'upfrontFee': upfront_fee,
                         'revShare': rev_share,
                         'p3PublicConstrRiskNPV': p3_public_constr_risk_npv,
                         'p3PublicOpsRiskNPV': p3_public_ops_risk_npv,
                         'publicConstrMitNPV': public_constr_mit_npv,
                         'publicOpsMitNPV': public_ops_mit_npv}

    vfm_abs = psc_net_cost - p3_net_cost
    vfm_pct = vfm_abs / abs(psc_net_cost) if psc_net_cost != 0 else 0

    return {
        'psc_discount_rate': rate,
        'psc_capex_npv': psc_capex_npv, 'psc_opex_npv': psc_opex_npv,
        'psc_constr_risk_npv': psc_constr_risk_npv, 'psc_ops_risk_npv': psc_ops_risk_npv,
        'psc_revenue_npv': psc_revenue_npv, 'comp_neutrality_adj': comp_neutrality_adj,
        'psc_mit_constr_npv': total_constr_mit_npv, 'psc_mit_ops_npv': total_ops_mit_npv,
        'psc_net_cost': psc_net_cost,
        'p3_net_cost': p3_net_cost, 'p3_components': p3_components,
        'is_availability_based': v.get('isAvailabilityBased', False),
        'vfm': vfm_abs, 'vfm_pct': vfm_pct,
        'mitigation': {
            'construction': {'total_one_time': total_constr_mit_cost,
                             'public': public_constr_mit_cost,
                             'private': total_constr_mit_cost - public_constr_mit_cost,
                             'total_npv': total_constr_mit_npv,
                             'public_npv': public_constr_mit_npv},
            'operations': {'total_annual': annual_ops_mit_cost,
                           'public': public_ops_mit_cost,
                           'private': annual_ops_mit_cost - public_ops_mit_cost,
                           'total_npv': total_ops_mit_npv,
                           'public_npv': public_ops_mit_npv},
            'total_npv': total_constr_mit_npv + total_ops_mit_npv,
            'public_npv': public_constr_mit_npv + public_ops_mit_npv,
            'benefit_constr': total_constr_ev_pre - total_constr_ev,
            'benefit_ops_annual': annual_ops_ev_pre - annual_ops_ev,
        },
        'risks': {
            'construction': {'total': total_constr_ev, 'total_pre': total_constr_ev_pre,
                             'public': public_constr_ev, 'private': private_constr_ev,
                             'items': cr},
            'operations': {'annual': annual_ops_ev, 'annual_pre': annual_ops_ev_pre,
                           'annual_public': annual_public_ops_ev,
                           'annual_private': annual_private_ops_ev,
                           'npv_total': psc_ops_risk_npv, 'items': or_},
        },
    }


def batch_vfm(alternatives: List[Tuple[str, Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Run VfM across multiple project alternatives. Returns ranked comparison.

    Args:
        alternatives: list of (label, model) tuples.

    Returns:
        list sorted by VfM descending; each entry has summary fields suitable for
        a comparison table (use `format_batch_vfm` for a printable view).
    """
    results = []
    for name, model in alternatives:
        try:
            full = build_full_model(model)
            vfm = build_vfm_analysis(model, full)
            results.append({
                'name': name,
                'delivery_mode': 'Availability' if vfm['is_availability_based'] else 'Toll',
                'psc_net_cost': vfm['psc_net_cost'],
                'p3_net_cost': vfm['p3_net_cost'],
                'vfm': vfm['vfm'],
                'vfm_pct': vfm['vfm_pct'],
                'construction_risk_ev': vfm['risks']['construction']['total'],
                'ops_risk_annual_ev': vfm['risks']['operations']['annual'],
                'private_risk_share_constr': (vfm['risks']['construction']['private']
                                              / vfm['risks']['construction']['total']
                                              if vfm['risks']['construction']['total'] > 0 else 0),
                'private_risk_share_ops': (vfm['risks']['operations']['annual_private']
                                          / vfm['risks']['operations']['annual']
                                          if vfm['risks']['operations']['annual'] > 0 else 0),
                'total_mit_npv': vfm.get('psc_mit_constr_npv', 0) + vfm.get('psc_mit_ops_npv', 0),
                'public_mit_npv': (vfm.get('p3_components', {}).get('publicConstrMitNPV', 0)
                                   + vfm.get('p3_components', {}).get('publicOpsMitNPV', 0)),
                'equity_irr': full.get('equity_irr'),
                'min_senior_dscr': full.get('min_senior_dscr'),
            })
        except Exception as e:
            results.append({'name': name, 'error': str(e)})
    return sorted(results, key=lambda r: r.get('vfm', float('-inf')), reverse=True)


def format_batch_vfm(results: List[Dict[str, Any]]) -> str:
    """Pretty-print a batch_vfm result as a tabular string."""
    lines = []
    header = f"{'Alternative':<42} {'Mode':<13} {'PSC NPV':>10} {'P3 NPV':>10} {'VfM':>10} {'VfM%':>7} {'PubMit':>8}"
    lines.append(header)
    lines.append('-' * len(header))
    for r in results:
        if 'error' in r:
            lines.append(f"{r['name']:<42} ERROR: {r['error']}")
        else:
            lines.append(f"{r['name']:<42} {r['delivery_mode']:<13} "
                         f"${r['psc_net_cost']/1e6:>7.0f}M ${r['p3_net_cost']/1e6:>7.0f}M "
                         f"${r['vfm']/1e6:>+7.0f}M {r['vfm_pct']*100:>+6.1f}% "
                         f"${r.get('public_mit_npv',0)/1e6:>5.1f}M")
    return '\n'.join(lines)



if __name__ == '__main__':
    import sys
    m = default_model()
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as f:
            m = json.load(f)
    r = build_full_model(m)
    print(f"Project:           {m['general']['projectName']}")
    print(f"Periods:           {len(r['periods'])} ({m['general']['periodsPerYear']}/year)")
    print(f"Total Capex:       ${r['capex_sched']['totalNominal']/1e6:,.1f}M")
    print(f"Cap. TIFIA Int.:   ${r['capitalized_tifia_interest']/1e6:,.1f}M")
    print(f"Total Uses:        ${r['total_uses']/1e6:,.1f}M")
    print(f"Total Sources:     ${r['total_sources']/1e6:,.1f}M")
    print(f"Funding Gap:       ${(r['total_uses']-r['total_sources'])/1e6:,.1f}M")
    print(f"Project IRR:       {(r['project_irr'] or 0)*100:.2f}%")
    print(f"Equity IRR:        {(r['equity_irr'] or 0)*100:.2f}%")
    print(f"Min Senior DSCR:   {(r['min_senior_dscr'] or 0):.2f}x")
    print(f"Avg Senior DSCR:   {(r['avg_senior_dscr'] or 0):.2f}x")
    print(f"Min LLCR:          {(r['min_llcr'] or 0):.2f}x")
    print(f"TIFIA all-in rate: {(r['tifia_all_in_rate'] or 0)*100:.3f}%")
    if r.get('tifia_effective_dscr') and r.get('tifia_target_dscr') and r['tifia_effective_dscr'] < r['tifia_target_dscr']:
        print(f"  ! TIFIA 50% test binding: effective DSCR {r['tifia_effective_dscr']:.2f}x vs target {r['tifia_target_dscr']:.2f}x")
    print(f"Lockup periods:    {sum(r['lockup'])} of {len(r['lockup'])}")
    # VfM summary
    vfm = build_vfm_analysis(m, r)
    print()
    print(f"VfM Analysis:      PSC ${vfm['psc_net_cost']/1e6:,.1f}M  vs  P3 ${vfm['p3_net_cost']/1e6:,.1f}M")
    print(f"                   VfM ${vfm['vfm']/1e6:+,.1f}M  ({vfm['vfm_pct']*100:+.1f}% of PSC)  "
          f"— {'P3 saves' if vfm['vfm'] > 0 else 'PSC preferred'}")
