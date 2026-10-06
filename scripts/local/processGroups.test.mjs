/* global process */
import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { groupAlive } from './lib.mjs';
afterEach(() => vi.restoreAllMocks());
it('does not mistake foreign procfs process IDs for an empty live process group', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  vi.spyOn(fs, 'readFileSync').mockReturnValue(`${process.pid + 100000} (node) R 1 1`);
  expect(groupAlive(12345)).toBe(true);
});
it('still recognizes an absent process group without consulting procfs', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  const read = vi.spyOn(fs, 'readFileSync');
  expect(groupAlive(12345)).toBe(false); expect(read).not.toHaveBeenCalled();
});
function foreignProcfs(state, sibling = false) {
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  vi.spyOn(fs, 'readdirSync').mockReturnValue(['90001']);
  vi.spyOn(fs, 'readlinkSync').mockImplementation(path => path === '/proc/self/ns/pid' || !sibling ? 'pid:[42]' : 'pid:[99]');
  vi.spyOn(fs, 'readFileSync').mockImplementation(path => {
    if (path === '/proc/self/stat') return '90000 (node) R 1 1';
    if (path === '/proc/self/status') return `NSpid:\t90000\t${process.pid}\n`;
    if (path === '/proc/90001/stat') return `90001 (node) ${state} 90000 80000`;
    if (path === '/proc/90001/status') return 'NSpgid:\t80000\t12345\n';
    throw new Error(`Unexpected path ${path}`);
  });
}
it('recognizes a live descendant using namespace group IDs rather than host IDs', () => {
  foreignProcfs('S');
  expect(groupAlive(12345)).toBe(true);
});
it('does not retain a group containing only zombies in a foreign procfs', () => {
  foreignProcfs('Z');
  expect(groupAlive(12345)).toBe(false);
});
it('does not confuse an identical group ID in a sibling namespace with its own group', () => {
  foreignProcfs('S', true);
  expect(groupAlive(12345)).toBe(false);
});
