import assert from 'node:assert/strict';
import { facetRows } from '../src/lib/dependent-filters.ts';
const rows = [
    { station: 'A', role: 'SM', provider: ['Amazon'], visible: true },
    { station: 'A', role: 'SI', provider: ['Amazon'], visible: true },
    { station: 'B', role: 'SM', provider: ['Flipkart', 'Amazon'], visible: true },
    { station: 'C', role: 'PTDA', provider: ['Flipkart'], visible: false },
];
const dimensions = (station = [], role = [], provider = []) => ({
    station: { selected: station, values: (r) => r.station },
    role: { selected: role, values: (r) => r.role },
    provider: { selected: provider, values: (r) => r.provider },
});
const scoped = rows.filter(r => r.visible);
const first = facetRows(scoped, dimensions(['A']));
assert.deepEqual(first.values('role'), ['SI', 'SM']);
assert.deepEqual(first.values('provider'), ['Amazon']);
assert.deepEqual(first.values('station'), ['A', 'B']); // Own multi-selection must not lock out alternatives.
const reverse = facetRows(scoped, dimensions([], ['SI']));
assert.deepEqual(reverse.values('station'), ['A']);
const multi = facetRows(scoped, dimensions(['A', 'B'], ['SM'], ['Flipkart']));
assert.equal(multi.rows.length, 1);
assert.deepEqual(multi.values('provider'), ['Amazon', 'Flipkart']);
const conflicting = facetRows(scoped, dimensions(['B'], ['SI']));
assert.equal(conflicting.rows.length, 0);
assert.deepEqual(conflicting.values('role'), ['SI', 'SM']); // Selected SI remains removable.
assert.deepEqual(conflicting.options('role', [{ value: 'SI' }, { value: 'SM' }, { value: 'PTDA' }]), [{ value: 'SI' }, { value: 'SM' }]);
assert.deepEqual(facetRows(scoped, dimensions(), r => r.station === 'B').values('role'), ['SM']);
assert.deepEqual(facetRows([], dimensions(['REMOVED'])).values('station'), ['REMOVED']);
assert.equal(facetRows(scoped, dimensions(['__NONE__'])).rows.length, 0);
// Normalization must affect both selection and master-option availability.
const normalized = facetRows([{ name: '  NORTH ', role: 'SM' }], {
    name: { selected: ['north'], values: r => r.name, normalize: (v) => v.trim().toLowerCase() },
    role: { selected: [], values: r => r.role }
});
assert.equal(normalized.rows.length, 1);
assert.deepEqual(normalized.options('name', [{ value: 'North' }, { value: 'South' }]), [{ value: 'North' }]);
// Compare all facets against a simple reference implementation across combinations.
for (const station of [[], ['A'], ['B'], ['A', 'B'], ['missing']]) {
    for (const role of [[], ['SM'], ['SI'], ['SI', 'SM'], ['PTDA']]) {
        for (const provider of [[], ['Amazon'], ['Flipkart']]) {
            const dims = dimensions(station, role, provider);
            const actual = facetRows(scoped, dims);
            const keys = Object.keys(dims);
            const matches = (row, key) => !dims[key].selected.length || dims[key].selected.some(v => [dims[key].values(row)].flat().includes(v));
            assert.deepEqual(actual.rows, scoped.filter(row => keys.every(key => matches(row, key))));
            for (const key of keys) {
                const expected = new Set(scoped.filter(row => keys.every(other => other === key || matches(row, other))).flatMap(row => dims[key].values(row)).filter(Boolean));
                assert.deepEqual([...actual.available[key]].sort(), [...expected].sort());
            }
        }
    }
}
// Guard the linear scan: no re-scanning rows once per option or copied full records.
let evaluated = 0;
const large = Array.from({ length: 100_000 }, (_, i) => ({ station: `S${i % 100}`, role: `R${i % 13}` }));
const started = performance.now();
const result = facetRows(large, {
    station: { selected: ['S1'], values: r => { evaluated++; return r.station; } },
    role: { selected: [], values: r => { evaluated++; return r.role; } },
});
assert.equal(evaluated, large.length * 2);
assert.equal(result.rows.length, 1000);
console.log(`Dependent filters passed; 100,000 rows / 2 dimensions: ${(performance.now() - started).toFixed(1)}ms.`);
