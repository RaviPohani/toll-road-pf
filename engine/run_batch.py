"""
run_batch.py — example batch workflows using toll_road_pf

Demonstrates:
  1. Single scenario run
  2. 2D sensitivity grid → CSV
  3. Monte-Carlo style traffic+toll shock sweep
  4. Single-instrument optimizer
  5. Iterative joint multi-tranche sizing
  6. Loading a model exported from the React frontend

Run with: python3 run_batch.py
"""

import csv
import copy
import random
import statistics
from toll_road_pf import (
    default_model, build_full_model,
    optimize_instrument, optimize_joint_tranches,
    sensitivity_grid, SHOCK_FNS,
    build_vfm_analysis, batch_vfm, format_batch_vfm,
)


def hdr(title):
    print()
    print('=' * 72)
    print(title)
    print('=' * 72)


# ----------------------------------------------------------------
# 1. SINGLE RUN
# ----------------------------------------------------------------
hdr('1. SINGLE RUN — DEFAULT MODEL')
m = default_model()
r = build_full_model(m)
print(f"Equity IRR: {r['equity_irr']*100:5.2f}%   Min Sr DSCR: {r['min_senior_dscr']:.2f}x   Min LLCR: {r['min_llcr']:.2f}x")
print(f"Total Uses: ${r['total_uses']/1e6:7.1f}M   Sources: ${r['total_sources']/1e6:7.1f}M   Gap: ${(r['total_uses']-r['total_sources'])/1e6:+.1f}M")


# ----------------------------------------------------------------
# 2. 2D SENSITIVITY GRID → CSV
# ----------------------------------------------------------------
hdr('2. SENSITIVITY GRID — AADT × Opex on Equity IRR')
aadt_shocks = [-0.20, -0.10, -0.05, 0.0, 0.05, 0.10]
opex_shocks = [-0.10, -0.05, 0.0, 0.05, 0.10, 0.15]
grid = sensitivity_grid(m, 'aadt', aadt_shocks, 'opex', opex_shocks,
                        metric_fn=lambda r: r['equity_irr'])

print(f"{'Opex \\ AADT':>14}" + ''.join(f"{x*100:>+9.1f}%" for x in aadt_shocks))
for i, ys in enumerate(opex_shocks):
    row = grid[i]
    cells = ''.join(f"{(v or 0)*100:>9.2f}%" for v in row)
    print(f"{ys*100:>+13.1f}%" + cells)

# Export to CSV
with open('sensitivity_aadt_opex.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Opex \\ AADT'] + [f'{x*100:+.1f}%' for x in aadt_shocks])
    for i, ys in enumerate(opex_shocks):
        w.writerow([f'{ys*100:+.1f}%'] + [(v or 0) for v in grid[i]])
print('-> sensitivity_aadt_opex.csv written')


# ----------------------------------------------------------------
# 3. MONTE-CARLO STRESS — 200 random traffic+toll+opex draws
# ----------------------------------------------------------------
hdr('3. MONTE-CARLO STRESS (n=200)')
random.seed(42)
irrs, dscrs = [], []
for _ in range(200):
    mm = copy.deepcopy(m)
    aadt_shock = random.gauss(0, 0.07)
    toll_shock = random.gauss(0, 0.03)
    opex_shock = random.gauss(0.02, 0.04)
    SHOCK_FNS['aadt'](mm, aadt_shock)
    SHOCK_FNS['toll'](mm, toll_shock)
    SHOCK_FNS['opex'](mm, opex_shock)
    rr = build_full_model(mm)
    if rr['equity_irr'] is not None:
        irrs.append(rr['equity_irr'])
    if rr['min_senior_dscr'] is not None:
        dscrs.append(rr['min_senior_dscr'])

print(f"Equity IRR  — mean {statistics.mean(irrs)*100:.2f}%, stdev {statistics.stdev(irrs)*100:.2f}%, "
      f"p5 {statistics.quantiles(irrs, n=20)[0]*100:.2f}%, p95 {statistics.quantiles(irrs, n=20)[18]*100:.2f}%")
print(f"Min Sr DSCR — mean {statistics.mean(dscrs):.2f}x, stdev {statistics.stdev(dscrs):.2f}x, "
      f"p5 {statistics.quantiles(dscrs, n=20)[0]:.2f}x, p95 {statistics.quantiles(dscrs, n=20)[18]:.2f}x")
breach = sum(1 for d in dscrs if d < 1.20)
print(f"DSCR < 1.20 breach probability: {breach/len(dscrs)*100:.1f}%")


# ----------------------------------------------------------------
# 4. SINGLE-INSTRUMENT OPTIMIZER
# ----------------------------------------------------------------
hdr('4. OPTIMIZER — size PABs against constraints')
opt = optimize_instrument(m, 'pab1', {
    'minSeniorDSCR': 1.30,
    'minLLCR': 1.30,
    # minTotalDSCR and enforceOverallObligation omitted — TIFIA 50% test
    # naturally binds those to ~1.0x. Relax both to size senior cleanly.
})
print(f"Optimal PAB principal: ${(opt['best'] or 0)/1e6:.1f}M  (current default: $280.0M)")
print(f"Iterations: {len(opt.get('iterations', []))}")
br = opt.get('best_results')
if br:
    print(f"Final min Sr DSCR: {br['min_senior_dscr']:.2f}x   Final min LLCR: {br['min_llcr']:.2f}x")
else:
    print("No feasible size found within search range — relax constraints.")


# ----------------------------------------------------------------
# 5. ITERATIVE JOINT MULTI-TRANCHE SIZING
# ----------------------------------------------------------------
hdr('5. JOINT OPTIMIZER — Senior + Sub with equity plug')
joint = optimize_joint_tranches(
    m,
    targets=[
        {'instrumentId': 'pab1',   'minDSCR': 1.30, 'minLLCR': 1.30},
        {'instrumentId': 'tifia1', 'minDSCR': 1.10, 'minLLCR': 1.20},
    ],
    shared_constraints={
        'minSeniorDSCR': 1.30,
        'minLLCR': 1.30,
        # minTotalDSCR / overall obligation omitted: TIFIA 50% solver binds total
        # DSCR to ~1.0x by design. Senior constraints are what drive sizing.
    },
    plug_instrument_id='eq1',
    max_outer_iter=8,
)
print(f"Converged: {joint['converged']}    Outer iterations: {joint['outer_iterations']}")
print(f"Final gap: ${joint['final_gap']/1e6:+.2f}M")
print(f"Total equity plug adjustment: ${joint['total_plug_adjustment']/1e6:+.2f}M")
print('Per-iteration trace:')
print(f"  {'iter':>4}  {'pre-gap':>10}  {'plug Δ':>10}  {'post-gap':>10}  {'min DSCR':>9}  {'min LLCR':>9}")
for h in joint['outer_history']:
    print(f"  {h['outerIter']:>4}  "
          f"{h['preGap']/1e6:>+9.2f}M  "
          f"{h['plugAdjustment']/1e6:>+9.2f}M  "
          f"{h['postGap']/1e6:>+9.2f}M  "
          f"{(h['min_senior_dscr'] or 0):>8.2f}x  "
          f"{(h['min_llcr'] or 0):>8.2f}x")
print('Final tranche sizes:')
for inst in joint['working_model']['financing']['instruments']:
    if inst['seniority'] in ('Senior', 'Subordinate', 'Equity'):
        print(f"  {inst['type']:<35}  ${inst['amount']/1e6:7.1f}M  ({inst['seniority']})")


# ----------------------------------------------------------------
# 6. BATCH VfM — Compare project alternatives
# ----------------------------------------------------------------
hdr('6. BATCH VfM — Compare Project Alternatives')

def with_changes(base, fn):
    new = copy.deepcopy(base)
    fn(new)
    return new

def alt_toll_high_share(mm):
    mm['vfm']['isAvailabilityBased'] = False
    mm['vfm']['revenueSharePct'] = 0.10
    mm['vfm']['upfrontConcessionFee'] = 100_000_000

def alt_toll_aggressive_risk(mm):
    # Push more risk to private (e.g., a more aggressive concession)
    mm['vfm']['isAvailabilityBased'] = False
    for r in mm['vfm']['riskRegister']:
        r['shareToPrivate'] = min(1.0, (r.get('shareToPrivate') or 0) + 0.10)

def alt_availability_modest(mm):
    mm['vfm']['isAvailabilityBased'] = True
    mm['vfm']['availabilityPaymentAnnual'] = 55_000_000

def alt_availability_high(mm):
    mm['vfm']['isAvailabilityBased'] = True
    mm['vfm']['availabilityPaymentAnnual'] = 80_000_000

alternatives = [
    ('Baseline (Toll, 5% rev share)',         m),
    ('Toll, 10% rev share + $100M fee',       with_changes(m, alt_toll_high_share)),
    ('Toll, push +10pp risk to private',      with_changes(m, alt_toll_aggressive_risk)),
    ('Availability $55M/yr',                  with_changes(m, alt_availability_modest)),
    ('Availability $80M/yr',                  with_changes(m, alt_availability_high)),
]
vfm_table = batch_vfm(alternatives)
print(format_batch_vfm(vfm_table))
print()
print(f"Best: {vfm_table[0]['name']}  →  VfM ${vfm_table[0]['vfm']/1e6:+.1f}M")
print(f"Worst: {vfm_table[-1]['name']}  →  VfM ${vfm_table[-1]['vfm']/1e6:+.1f}M")

# Export to CSV for sharing
with open('vfm_alternatives.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Alternative','Mode','PSC NPV ($M)','P3 NPV ($M)','VfM ($M)','VfM %','Constr Risk EV ($M)','Ops Risk Annual EV ($M)','Private Risk Share (Constr)','Private Risk Share (Ops)','Total Mit NPV ($M)','Public Mit NPV ($M)','Equity IRR','Min Sr DSCR'])
    for r in vfm_table:
        if 'error' in r: continue
        w.writerow([r['name'], r['delivery_mode'],
                    round(r['psc_net_cost']/1e6, 2), round(r['p3_net_cost']/1e6, 2),
                    round(r['vfm']/1e6, 2), round(r['vfm_pct']*100, 2),
                    round(r['construction_risk_ev']/1e6, 2), round(r['ops_risk_annual_ev']/1e6, 2),
                    round(r['private_risk_share_constr']*100, 1), round(r['private_risk_share_ops']*100, 1),
                    round(r.get('total_mit_npv',0)/1e6, 2), round(r.get('public_mit_npv',0)/1e6, 2),
                    round((r['equity_irr'] or 0)*100, 2), round(r['min_senior_dscr'] or 0, 2)])
print('-> vfm_alternatives.csv written')


# ----------------------------------------------------------------
# 7. LOADING A MODEL EXPORTED FROM THE REACT FRONTEND
# ----------------------------------------------------------------
hdr('6. LOADING A FRONTEND-EXPORTED MODEL')
print("""
If you save a scenario in the frontend, it persists as JSON in browser storage.
To use it here, export it as a .json file (any browser dev tool will let you copy
the storage value) and run:

    import json
    from toll_road_pf import build_full_model

    with open('my_scenario.json') as f:
        model = json.load(f)
    results = build_full_model(model)

Or just pass it on the CLI:  python3 toll_road_pf.py my_scenario.json
""")
