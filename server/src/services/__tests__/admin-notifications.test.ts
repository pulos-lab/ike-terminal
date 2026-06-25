import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImportProfileRow } from '../../db/import-profiles-repo.js';

// Mock transportu — zachowujemy prawdziwy escapeHtml (test anty-wstrzyknięcia),
// podmieniamy tylko sendEmail na spy. Mock auth.js, żeby nie ładować realnej
// inicjalizacji better-auth / auth.db przy imporcie.
vi.mock('../email.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../email.js')>();
  return { ...actual, sendEmail: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../auth.js', () => ({ getAuthDb: vi.fn() }));

import { notifyNewImportProfile, notifyNewBugReport } from '../admin-notifications.js';
import { sendEmail } from '../email.js';
import { getAuthDb } from '../../auth.js';

const ADMIN = { id: 'admin-1', email: 'admin@example.com' };

function mockAuthDb(
  admin: { id: string; email: string } | undefined,
  usersById: Record<string, { email: string }> = {},
): void {
  vi.mocked(getAuthDb).mockReturnValue({
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (sql.includes('ORDER BY createdAt')) return admin;
        if (sql.includes('WHERE id')) return usersById[args[0] as string];
        return undefined;
      },
    }),
  } as unknown as ReturnType<typeof getAuthDb>);
}

function profileRow(over: Partial<ImportProfileRow> = {}): ImportProfileRow {
  return {
    id: 'p1',
    fingerprint: 'abcdef1234567890',
    version: 1,
    status: 'pending',
    specVersion: 1,
    profile: {} as ImportProfileRow['profile'],
    brokerLabel: 'Test Broker',
    headerNames: [],
    delimiter: ';',
    sampleRows: null,
    generatedBy: 'llm',
    createdByUserId: 'user-2',
    createdAt: '2026-06-25T10:00:00',
    usageCount: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(sendEmail).mockClear();
  delete process.env.ADMIN_NOTIFICATIONS;
  mockAuthDb(ADMIN, { 'user-2': { email: 'user2@example.com' } });
});

describe('notifyNewImportProfile', () => {
  it('wysyła do admina, gdy profil utworzył inny user (AI)', async () => {
    await notifyNewImportProfile(profileRow());
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendEmail).mock.calls[0][0];
    expect(arg.to).toBe(ADMIN.email);
    expect(arg.subject).toContain('Test Broker');
    expect(arg.html).toContain('user2@example.com');
    expect(arg.html).toContain('/app/admin/import-profiles');
  });

  it('pomija, gdy profil utworzył sam admin (skip-own)', async () => {
    await notifyNewImportProfile(profileRow({ createdByUserId: ADMIN.id }));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('pomija edycje admina (generatedBy=admin)', async () => {
    await notifyNewImportProfile(profileRow({ generatedBy: 'admin', createdByUserId: 'user-2' }));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('pomija, gdy wyłączone (ADMIN_NOTIFICATIONS=off)', async () => {
    process.env.ADMIN_NOTIFICATIONS = 'off';
    await notifyNewImportProfile(profileRow());
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('no-op, gdy brak admina w bazie', async () => {
    mockAuthDb(undefined);
    await notifyNewImportProfile(profileRow());
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('ręczne mapowanie + fallback fingerprint, gdy brak brokerLabel', async () => {
    await notifyNewImportProfile(profileRow({ generatedBy: 'manual', brokerLabel: null }));
    const arg = vi.mocked(sendEmail).mock.calls[0][0];
    expect(arg.subject).toContain('abcdef12');
    expect(arg.html).toContain('ręczne mapowanie');
  });

  it('nie rzuca, gdy sendEmail zawiedzie', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('boom'));
    await expect(notifyNewImportProfile(profileRow())).resolves.toBeUndefined();
  });
});

describe('notifyNewBugReport', () => {
  const base = {
    category: 'import',
    description: 'coś nie działa',
    reporterEmail: 'user2@example.com',
    reporterUserId: 'user-2',
  };

  it('wysyła do admina o zgłoszeniu innego usera', async () => {
    await notifyNewBugReport(base);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendEmail).mock.calls[0][0];
    expect(arg.to).toBe(ADMIN.email);
    expect(arg.subject).toContain('import');
    expect(arg.html).toContain('coś nie działa');
    expect(arg.html).toContain('/app/admin/bugs');
  });

  it('pomija własne zgłoszenie admina (skip-own)', async () => {
    await notifyNewBugReport({ ...base, reporterUserId: ADMIN.id });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("escape'uje opis (anty-wstrzyknięcie HTML)", async () => {
    await notifyNewBugReport({ ...base, description: '<script>alert(1)</script>' });
    const arg = vi.mocked(sendEmail).mock.calls[0][0];
    expect(arg.html).not.toContain('<script>');
    expect(arg.html).toContain('&lt;script&gt;');
  });
});
