import { describe, expect, it } from 'vitest';
import { loadCapabilityCatalog, loadSkillCatalog, phase1SkillNames, validateCatalogBundle } from '../src/catalog.js';

describe('general skill catalog', () => {
  it('contains the approved lite Copilot project skills', () => {
    const catalog = loadSkillCatalog();
    const validation = validateCatalogBundle();
    const liteSkills = phase1SkillNames(catalog);

    expect(validation.issues).toEqual([]);
    expect(catalog.commandPrefix).toBe('/');
    expect(catalog.skills.map((skill) => skill.name)).toEqual(liteSkills);

    const commands = new Set(catalog.skills.flatMap((skill) => skill.slashCommands));
    expect([...commands]).toEqual(expect.arrayContaining(liteSkills));
  });

  it('marks every Copilot compatibility state as supported, fallback, or unsupported', () => {
    const capabilities = loadCapabilityCatalog();
    for (const capability of capabilities.capabilities) {
      expect(capability.providers, capability.id).toBeTruthy();
      for (const state of Object.values(capability.providers ?? {})) {
        expect(['supported', 'fallback', 'unsupported'], `${capability.id}:${state}`).toContain(state);
      }
    }
  });

  it('keeps all Phase 1 capability surfaces native project skills', () => {
    const capabilities = loadCapabilityCatalog();
    const liteSkills = phase1SkillNames();
    for (const id of liteSkills) {
      const capability = capabilities.capabilities.find((entry) => entry.id === id);
      expect(capability, `${id} capability exists`).toBeTruthy();
      expect(capability?.providerSupport.copilot.state).toBe('native');
      expect(capability?.providerSupport.copilot.notes).toContain(`/${id}`);
    }
  });

  it('does not present lite execution skills as durable runtimes', () => {
    const capabilities = loadCapabilityCatalog();
    for (const id of ['team', 'execution.parallel', 'ralph', 'execution.single-owner', 'ultrawork', 'omp-autopilot', 'execution.autonomous']) {
      const capability = capabilities.capabilities.find((entry) => entry.id === id);
      expect(capability, `${id} capability exists`).toBeTruthy();
      expect(capability?.providerSupport.copilot.state).toBe('native');
      expect(capability?.providerSupport.copilot.notes).toMatch(/not a durable runtime/i);
    }
  });
});
