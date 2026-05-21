import { describe, expect, it } from 'vitest';
import { loadCapabilityCatalog, loadSkillCatalog, validateCatalogBundle } from '../src/catalog.js';

describe('general skill catalog', () => {
  it('contains the approved MVP Copilot project skills', () => {
    const catalog = loadSkillCatalog();
    const validation = validateCatalogBundle();

    expect(validation.issues).toEqual([]);
    expect(catalog.skills.map((skill) => skill.name)).toEqual([
      'grill',
      'ralplan',
      'team',
      'ralph',
      'jira-ticket',
      'code-review',
      'qa',
      'verify',
    ]);

    const commands = new Set(catalog.skills.flatMap((skill) => skill.slashCommands));
    expect([...commands]).toEqual(
      expect.arrayContaining(['grill', 'grill-me', 'ralplan', 'team', 'ralph', 'verify', 'jira-ticket', 'code-review', 'qa']),
    );
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

  it('keeps team and ralph as thin Copilot handoffs', () => {
    const capabilities = loadCapabilityCatalog();
    for (const id of ['team', 'ralph', 'execution.single-owner', 'execution.parallel']) {
      const capability = capabilities.capabilities.find((entry) => entry.id === id);
      expect(capability, `${id} capability exists`).toBeTruthy();
      expect(capability?.providerSupport.copilot.state).toBe('handoff');
    }
  });
});
