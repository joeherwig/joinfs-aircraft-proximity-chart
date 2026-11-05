// The collapsed designators (GLID, GLIM ...) through the port of JoinFS' matcher: the same scenarios as JoinFS.Tests/FoldedScenarioTests (FoldedScenarios.json),
// and the nodes the map adds for the types of a loaded model set. (The 281 golden scenarios of every type are in joinfs-parity.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseModels, groupModels, virtualAircraft, isLookupLine } from '../src/models.js';
import { createMatcher, makeReference, makeDoc8643, makeAirlines } from '../src/joinfs-matcher.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const aircraft = JSON.parse(read('aircraft-specs.json')).aircraft;
const doc8643Table = JSON.parse(read('doc8643.json'));
const matcher = createMatcher({ reference: makeReference(aircraft), doc8643: makeDoc8643(doc8643Table), airlines: makeAirlines(JSON.parse(read('airlines.json'))) });
const fixture = JSON.parse(read('test/fixtures/folded-scenarios.json'));

// models as a JoinFS list line (the role text "Segler" is what the JoinFS tests give the gliders)
const asModels = list => parseModels(['# new separator - DO NOT DELETE THIS LINE', ...list.map(m => [m.title, m.manufacturer ?? '', m.type ?? '', m.variation, '0', 'Segler', '0', '', m.tag, 'L', '', '', 'False'].join('[+]'))].join('\n'));

for (const scenario of fixture.scenarios) {
  test(`same answer as JoinFS: ${scenario.name}`, () => {
    const models = matcher.prepareModels(asModels(scenario.installed));
    const result = matcher.match(models, { icaoType: scenario.remote.tag, title: scenario.remote.title });

    assert.ok(result, 'something is acceptable');
    if (scenario.expect) assert.equal(result.model.title, scenario.expect);
    if (scenario.expectNot) assert.notEqual(result.model.title, scenario.expectNot);
    if (scenario.expectVariation) assert.equal(result.model.variation, scenario.expectVariation);
  });
}

test('the collapsed designators are the ones Doc8643 marks with the placeholder manufacturer', () => {
  const doc = makeDoc8643(doc8643Table);
  const collapsed = Object.keys(doc8643Table).filter(k => doc.isCollapsed(k)).sort();
  assert.deepEqual(collapsed, ['BALL', 'GLID', 'GLIM', 'GYRO', 'PARA', 'SHIP', 'UHEL', 'ULAC']);
});

test('the generic class lines of a collapsed designator are lookup lines, nothing else is', () => {
  const at = (icao, name) => aircraft.findIndex(a => a.icao === icao && (!name || a.name === name));
  assert.equal(isLookupLine(aircraft, at('GLID', 'Glider, 15 m class')), true);
  assert.equal(isLookupLine(aircraft, at('GLID', 'Generic glider')), true);
  assert.equal(isLookupLine(aircraft, at('GLIM', 'Generic motor glider')), true);
  assert.equal(isLookupLine(aircraft, at('BALL')), false, 'a collapsed designator with a single "-" line can be used');
  assert.equal(isLookupLine(aircraft, at('C172')), false);
  assert.equal(isLookupLine(aircraft, at('AS21')), false, 'a specific glider with a manufacturer is a real aircraft');
});

// ---- the types of a loaded model set that the data does not know get nodes of their own (while the set is loaded) ----

const msfsExcerpt = [
  { title: 'SZD-30 D-6758', manufacturer: 'SZD', type: 'SZD-30 Pirat', variation: 'D-6785', tag: 'SZD30' },
  { title: 'SZD-30 Pirat', manufacturer: 'SZD', type: 'SZD-30 Pirat', variation: 'SP-2896', tag: 'SZD30' },
  { title: 'Schleicher K7 GlideSimmer+B21', manufacturer: 'Schleicher', type: 'K7', variation: 'Two seat trainer', tag: 'AS7' },
  { title: 'K7 Cream/Red (imperial)', manufacturer: 'Schleicher', type: 'K7', variation: 'Cream/Red (knots)', tag: 'AS7' },
  { title: 'LS4 Red', manufacturer: 'Rolladen Schneider', type: '', variation: 'LS4 Red', tag: 'LS4' },
  { title: 'JS3-15 D-KSBK (TN)', manufacturer: 'Jonker', type: 'JS3-15', variation: 'Katrin Senna', tag: 'JS3-15' },
  { title: 'JS3-18 Rapture B21', manufacturer: 'Jonker', type: 'JS3-18', variation: 'B21', tag: 'JS3-18' },
  { title: 'AS-33me 7', manufacturer: 'Alexander Schleicher', type: 'AS 33 Me', variation: '7', tag: 'AS33me' },
  { title: 'DG LS8', manufacturer: '', type: '', variation: '', tag: 'LS8' },
  { title: 'Airbus H145 ADAC Crew', manufacturer: 'Airbus Helicopters', type: '', variation: '', tag: 'H145 Crew' },
  { title: 'Airbus H145 Car Crash 1', manufacturer: 'Airbus Helicopters', type: '', variation: '', tag: 'CAR' },
  { title: 'Airbus H145 Golf cart', manufacturer: 'Airbus Helicopters', type: '', variation: '', tag: 'GOLF' },
  { title: 'Magni M24 Plus White', manufacturer: '', type: '', variation: '', tag: 'PLUS' },
  { title: 'FSLTL_B73X_ZZZZ', manufacturer: 'BOEING', type: '', variation: '', tag: '737' },
  { title: 'Cessna 172 Skyhawk', manufacturer: 'Cessna', type: '', variation: '', tag: 'C172' },
  { title: 'Untagged glider', manufacturer: '', type: '', variation: '', tag: '' },
];

test('only the glider tags the data does not know become nodes, not the junk tags of a list or known types', () => {
  const nodes = virtualAircraft(asModels(msfsExcerpt), aircraft);
  assert.deepEqual(nodes.map(n => n.icao).sort(), ['AS33me', 'AS7', 'JS3-15', 'JS3-18', 'LS4', 'SZD30']);
  assert.deepEqual(virtualAircraft([], aircraft), []);
});

test('a node takes the parameters of the class line that lists its title hint, and its name and manufacturer from the model list', () => {
  const nodes = Object.fromEntries(virtualAircraft(asModels(msfsExcerpt), aircraft).map(n => [n.icao, n]));
  const line = name => aircraft.find(a => a.name === name);
  assert.equal(nodes.SZD30.mtowKg, line('Glider, classic wooden').mtowKg);
  assert.equal(nodes['JS3-18'].spanM, 18);
  assert.equal(nodes['JS3-18'].mtowKg, 600);
  assert.equal(nodes.AS7.manufacturer, 'Schleicher');
  assert.equal(nodes.AS7.name, 'Schleicher K7');
  assert.equal(nodes['JS3-15'].name, 'Jonker JS3-15');
  assert.equal(nodes.LS4.name, 'LS4');                      // the list gives no type: the tag is the name
  assert.ok(nodes.SZD30.virtual && nodes.SZD30.nonIcao);
  assert.equal(aircraft[nodes.SZD30.lookup].name, 'Glider, classic wooden');
  assert.equal(isLookupLine([...aircraft, nodes.SZD30], aircraft.length), false, 'a node with a manufacturer is a real aircraft');
});

test('with the nodes the models sit on them, the generic class lines stay without them', () => {
  const extended = [...aircraft, ...virtualAircraft(asModels(msfsExcerpt), aircraft)];
  const grouped = groupModels(asModels(msfsExcerpt), extended);
  const at = tag => extended.findIndex(a => a.icao === tag);
  assert.deepEqual((grouped.byAircraft.get(at('SZD30')) ?? []).map(m => m.title), ['SZD-30 D-6758', 'SZD-30 Pirat']);
  assert.equal((grouped.byAircraft.get(at('AS7')) ?? []).length, 2);
  const classic = aircraft.findIndex(a => a.name === 'Glider, classic wooden');
  assert.equal((grouped.byAircraft.get(classic) ?? []).length, 0);
});
