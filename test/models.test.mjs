import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseModels, groupModels } from '../src/models.js';

const data = JSON.parse(readFileSync(new URL('../aircraft-specs.json', import.meta.url), 'utf8')).aircraft;
const line = (title, livery, icao) => [title, '', title, livery, '0', 'Verkehrsflz', '0', '', icao, 'M', 'AEE', 'L2J', 'True'].join('[+]');
const text = ['# new separator - DO NOT DELETE THIS LINE', line('A', 'Aegean', 'A20N'), line('B', 'Easy', 'A32N'), line('B', 'Easy', 'A32N'), line('C', 'None', ''), line('D', 'X', 'ZZZZ'), ''].join('\n');

test('parseModels reads title, livery and ICAO type', () => {
  const m = parseModels(text);
  assert.equal(m.length, 5);
  assert.deepEqual([m[0].title, m[0].livery, m[0].icaoType], ['A', 'Aegean', 'A20N']);
});

test('groupModels assigns by ICAO type or alias, drops duplicates and counts unmatched', () => {
  const { byAircraft, unmatched } = groupModels(parseModels(text), data);
  const a20n = data.findIndex(a => a.icao === 'A20N');
  assert.equal(byAircraft.get(a20n).length, 2); // A32N is an alias of A20N
  assert.equal(unmatched, 2);
});

test('the old "|" separator is understood', () => {
  assert.equal(parseModels('t|m|y|livery|0').length, 1);
});

test('resolveAirline finds the airline in the models list by code, callsign or name', async () => {
  const { resolveAirline } = await import('../src/models.js');
  const m = parseModels(['# new separator', line('A320 Lufthansa', 'Deutsche Lufthansa', 'A320').replace('AEE', 'DLH'), line('A320 Lufthansa 2', 'Lufthansa Cityline', 'A320').replace('AEE', 'DLH')].join('\n'));
  assert.equal(resolveAirline('DLH', m), 'DLH');
  assert.equal(resolveAirline('dlh456', m), 'DLH');
  assert.equal(resolveAirline('Lufthansa 12', m), 'DLH');
  assert.equal(resolveAirline('XYZ1', m), '');
  assert.equal(resolveAirline('', m), '');
});

test('callsignScore finds a registration as a word in title or livery', async () => {
  const { callsignScore, modelScore } = await import('../src/models.js');
  const m = { title: 'TBM 930 N960VM', livery: '', airline: '' };
  assert.equal(callsignScore(m, 'N960VM'), 5);
  assert.equal(callsignScore(m, 'n-960-vm'), 5);
  assert.equal(callsignScore({ ...m, title: 'TBM 930 N960VMX' }, 'N960VM'), 0);
  assert.equal(callsignScore(m, 'N9'), 0);
  assert.equal(modelScore(m, '', 'N960VM'), 5);
});

// ---- designators ICAO folded several aircraft into (GLID, GLIM ...): the title picks the row, like JoinFS' FindForText ----

const row = (icao, name, hints, extra = {}) => ({ icao, name, manufacturer: '-', titleHints: hints, engineType: 'none', mtowKg: 500, ...extra });
const folded = [
  row('GLID', 'Generic glider', ['Glider']),
  row('GLID', 'Glider, classic wooden', ['Grunau Baby', 'Ka 6'], { mtowKg: 300 }),
  row('AS21', 'Schleicher ASK 21', ['ASK 21'], { mtowKg: 600 }),
  row('C172', 'Cessna 172', ['Skyhawk'], { engineType: 'piston', mtowKg: 1100 }),
];
const modelsOf = (...titles) => parseModels(['# new separator', ...titles.map(([title, icao]) => line(title, '', icao))].join('\n'));
const titlesIn = (grouped, icao, name) => (grouped.byAircraft.get(folded.findIndex(a => a.icao === icao && a.name === name)) ?? []).map(m => m.title);

test('a model of a folded designator goes to the row its title names, else to the first row', () => {
  const grouped = groupModels(modelsOf(['Grunau Baby IIb', 'GLID'], ['Mystery 77', 'GLID']), folded);
  assert.deepEqual(titlesIn(grouped, 'GLID', 'Glider, classic wooden'), ['Grunau Baby IIb']);
  assert.deepEqual(titlesIn(grouped, 'GLID', 'Generic glider'), ['Mystery 77']);
  assert.equal(grouped.unmatched, 0);
});

test('the longest hint wins and a hint must be a whole word', () => {
  const grouped = groupModels(modelsOf(['Glider Grunau Baby', 'GLID'], ['Ka 66 Special', 'GLID']), folded);
  assert.deepEqual(titlesIn(grouped, 'GLID', 'Glider, classic wooden'), ['Glider Grunau Baby']);
  assert.deepEqual(titlesIn(grouped, 'GLID', 'Generic glider'), ['Ka 66 Special']);
});

test('a specific glider type named in the title of a folded-designator model takes the model, a car does not', () => {
  const grouped = groupModels(modelsOf(['Schleicher ASK 21 Club', 'GLID'], ['Glider towed by Skyhawk', 'GLID']), folded);
  assert.deepEqual(titlesIn(grouped, 'AS21', 'Schleicher ASK 21'), ['Schleicher ASK 21 Club']);
  assert.deepEqual(titlesIn(grouped, 'GLID', 'Generic glider'), ['Glider towed by Skyhawk']);
});

test('a designator with one row ignores the title', () => {
  const grouped = groupModels(modelsOf(['Grunau Baby', 'C172']), folded);
  assert.deepEqual(titlesIn(grouped, 'C172', 'Cessna 172'), ['Grunau Baby']);
});

test('on the real data GLID and GLIM have several rows, the generic one first', () => {
  for (const icao of ['GLID', 'GLIM']) {
    const rows = data.filter(a => a.icao === icao);
    assert.ok(rows.length >= 2, icao);
    assert.match(rows[0].name, /^Generic/);
  }
});

// ---- shared title words: the same rule and constants as JoinFS' TitleTokens / CombinedMatcher.TitleTokenBonus ----

import { titleTokens, sharedTitleWords, titleBonus, TITLE_TOKEN_BONUS_MAX } from '../src/models.js';

test('title words ignore case, punctuation and generic words, and a designation reads the same with or without a space', () => {
  assert.equal(sharedTitleWords('Glider', 'Glider'), 0);
  assert.equal(sharedTitleWords('Grunau Baby', 'Discus'), 0);
  assert.equal(sharedTitleWords('', 'Discus'), 0);
  assert.ok(sharedTitleWords('DG-1001 Neo', 'dg 1001 neo') >= 2);
  assert.ok(sharedTitleWords('ASK 21', 'ASK21 Club') > sharedTitleWords('ASK 21', 'ASK 13'));
  assert.ok(sharedTitleWords('ASK 21', 'Schleicher ASK 21') > sharedTitleWords('ASK 21', 'ASK 13'));
  assert.ok(titleTokens('ASK 21').has('ask21'));
});

test('the title bonus is ten points per shared word, at most thirty', () => {
  assert.equal(titleBonus('Grunau Baby', 'Discus'), 0);
  assert.equal(titleBonus('Quasar 7', 'Zeta Quasar 7') > 0, true);
  assert.equal(titleBonus('Quasar Nova Ultra Big 7', 'Quasar Nova Ultra Big 7'), TITLE_TOKEN_BONUS_MAX);
});

// ---- a tag that is not a designator ("JS3-15" in MSFS lists) or no tag: the type is inferred from the title, like JoinFS' InferIcaoFromText ----

const rowOf = (grouped, name) => (grouped.byAircraft.get(data.findIndex(a => a.name === name)) ?? []).map(m => m.title);

test('a model whose tag is not a designator is placed by its title', () => {
  const grouped = groupModels(modelsOf(['JS3-15 white', 'JS3-15'], ['JS3-18 red', 'JS3-18'], ['DG-1001-E Neo', ''], ['Totally unknown thing', 'QQQQ']), data);
  assert.deepEqual(rowOf(grouped, 'Glider, 15 m class'), ['JS3-15 white']);
  assert.deepEqual(rowOf(grouped, 'Glider, 18 m class'), ['JS3-18 red']);
  assert.deepEqual(rowOf(grouped, 'DG Flugzeugbau DG-1001'), ['DG-1001-E Neo']);
  assert.equal(grouped.unmatched, 1);
});

test('a title never moves a model whose tag is a known designator', () => {
  const grouped = groupModels(modelsOf(['A-10 Warthog skin', 'C172']), data);
  assert.deepEqual(rowOf(grouped, 'Cessna 172 Skyhawk').length + rowOf(grouped, 'Fairchild A-10 Thunderbolt II').length, 1);
  assert.deepEqual(rowOf(grouped, 'Fairchild A-10 Thunderbolt II'), []);
});

// ---- ordering the installed models of a row by the remote title: an exact title is JoinFS' "Original" tier and always comes first ----

import { titleFit } from '../src/models.js';

test('a model with exactly the remote title ranks above models that merely share words', () => {
  const remote = 'K7 Cream/Green (imperial)';
  const titles = ['K7 Cream/Blue(imperial)', 'K7 Cream/Red (imperial)', 'K7 Cream/Green (imperial)', 'K7 Red (metric)'];
  const ranked = [...titles].sort((a, b) => titleFit(remote, b) - titleFit(remote, a));
  assert.equal(ranked[0], 'K7 Cream/Green (imperial)');
  assert.equal(ranked[3], 'K7 Red (metric)');
});

test('without an exact title, more shared words rank higher, even beyond the 30 point cap', () => {
  assert.ok(titleFit('Quasar Nova Ultra Big 7', 'Quasar Nova Ultra Big 7 X') > titleFit('Quasar Nova Ultra Big 7', 'Quasar Nova'));
  assert.equal(titleFit('', 'Anything'), 0);
});

// ---- K7, LS4 and SZD-30 have no rows of their own: the class lines list them as title hints and supply their parameters ----

import { pickRow } from '../src/models.js';

const glidRows = () => data.map((a, i) => i).filter(i => data[i].icao === 'GLID');
const nameOf = t => data[pickRow(glidRows(), data, t)].name;

test('a title naming a listed member picks the class line that lists it', () => {
  assert.equal(nameOf('K7 Cream/Red (imperial)'), 'Glider, classic wooden');
  assert.equal(nameOf('LS4 Swiss'), 'Glider, standard class 15 m');
  assert.equal(nameOf('SZD-30 Pirat'), 'Glider, classic wooden');
  assert.equal(nameOf('Grunau Baby II'), 'Glider, classic wooden');
  assert.equal(nameOf('Mystery 77'), 'Generic glider');
});

test('models tagged AS7, LS4 and SZD30 sit on the class line that lists them, there are no rows of their own', () => {
  assert.ok(!data.some(a => ['AS7', 'LS4', 'SZD30'].includes(a.icao)));
  const grouped = groupModels(modelsOf(['K7 Cream/Red (imperial)', 'AS7'], ['LS4 Blue', 'LS4'], ['SZD-30 Pirat', 'SZD30']), data);
  assert.deepEqual(rowOf(grouped, 'Glider, classic wooden'), ['K7 Cream/Red (imperial)', 'SZD-30 Pirat']);
  assert.deepEqual(rowOf(grouped, 'Glider, standard class 15 m'), ['LS4 Blue']);
  assert.equal(grouped.unmatched, 0);
});

// ---- the JS3 has no row of its own: the class line that lists it as a hint supplies its parameters and holds its models ----

test('models tagged JS3-15 and JS3-18 sit on the class line that lists them as a hint, their liveries stay liveries', () => {
  const grouped = groupModels(modelsOf(['JS3-15 D-KSBK (TN)', 'JS3-15'], ['JS3-15 white', 'JS3-15'], ['JS3-18 Waldo', 'JS3-18']), data);
  assert.ok(!data.some(a => a.icao.startsWith('JS3-')));
  assert.deepEqual(rowOf(grouped, 'Glider, 15 m class'), ['JS3-15 D-KSBK (TN)', 'JS3-15 white']);
  assert.deepEqual(rowOf(grouped, 'Glider, 18 m class'), ['JS3-18 Waldo']);
  assert.equal(grouped.unmatched, 0);
});

test('a model without a designator tag is placed by the type its title names, like JoinFS does (an untagged "Cabri G2" is a G2CA)', () => {
  const untagged = parseModels(['# new separator - DO NOT DELETE THIS LINE', line('Cabri G2 Passengers', 'Flight Seeing 05', ''), line('Totally Unknown Thing', 'X', ''), ''].join('\n'));
  const { byAircraft, unmatched } = groupModels(untagged, data);
  const g2ca = data.findIndex(a => a.icao === 'G2CA');
  assert.equal(byAircraft.get(g2ca)?.length, 1);
  assert.equal(unmatched, 1);
});
