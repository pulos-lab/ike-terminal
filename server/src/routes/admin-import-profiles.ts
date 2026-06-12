/**
 * Kuracja profili importu generycznego (Faza 5) — /api/admin/import-profiles.
 * Montowany za requireAuth + requireAdmin (index.ts). Prywatność: admin widzi
 * WYŁĄCZNIE zredagowane próbki zapisane z profilem — dry-run również biegnie
 * na zredagowanej próbce, nigdy na surowych plikach użytkowników.
 */
import { Router } from 'express';
import Papa from 'papaparse';
import { validateImportProfile } from 'shared';
import {
  adminEditProfile,
  approveProfile,
  getProfileById,
  getProfileForAdmin,
  listProfileAudit,
  listProfilesForAdmin,
  profileChangedSections,
  rejectProfile,
  type ProfileStatus,
} from '../db/import-profiles-repo.js';
import { previewGeneric } from '../services/generic-import-service.js';
import { asyncHandler } from '../middleware/async-handler.js';

const router = Router();

const STATUSES: ProfileStatus[] = ['pending', 'approved', 'rejected', 'superseded'];

/** GET / — kolejka review (domyślnie wszystkie; ?status=pending zawęża). */
router.get('/', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status && !STATUSES.includes(status as ProfileStatus)) {
    return res.status(400).json({ error: `Nieznany status: ${status}` });
  }
  const profiles = listProfilesForAdmin(status as ProfileStatus | undefined).map((p) => ({
    ...p,
    profile: undefined, // lista jest lekka — pełny JSON w GET /:id
    sampleRows: undefined,
  }));
  res.json({ profiles });
});

/**
 * GET /:id — pełny profil + zredagowane próbki + dry-run profilu na próbce
 * + diff względem aktualnie zatwierdzonej wersji + audyt.
 */
router.get(
  '/:id',
  asyncHandler((req, res) => {
    const profile = getProfileForAdmin(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Profil nie istnieje' });

    // Dry-run na ZREDAGOWANEJ próbce (nagłówek + wiersze odtworzone do CSV).
    let dryRun = null;
    if (profile.sampleRows && profile.sampleRows.length > 0) {
      const csv = Papa.unparse([profile.headerNames, ...profile.sampleRows], {
        delimiter: profile.delimiter,
      });
      dryRun = previewGeneric({ buffer: Buffer.from(csv, 'utf-8') }, profile.profile);
    }

    // Diff względem aktualnej wersji approved tego fingerprinta (jeśli inna).
    const approved = listProfilesForAdmin('approved').find(
      (p) => p.fingerprint === profile.fingerprint && p.id !== profile.id,
    );
    const diff = approved
      ? {
          againstId: approved.id,
          againstVersion: approved.version,
          changedSections: profileChangedSections(approved.profile, profile.profile),
        }
      : null;

    res.json({ profile, dryRun, diff, audit: listProfileAudit(profile.id) });
  }),
);

/** PUT /:id — korekta admina: nowa wersja 'pending' (generatedBy='admin'). */
router.put(
  '/:id',
  asyncHandler((req, res) => {
    const base = getProfileById(req.params.id);
    if (!base) return res.status(404).json({ error: 'Profil nie istnieje' });

    const validation = validateImportProfile(req.body?.profile);
    if (!validation.ok) {
      return res
        .status(422)
        .json({ error: 'Profil nie przechodzi walidacji', details: validation.errors });
    }
    const inserted = adminEditProfile({
      baseId: base.id,
      profile: validation.profile,
      adminUserId: req.userId!,
    });
    res.json({ profile: inserted });
  }),
);

/** POST /:id/approve — zatwierdzenie; batche innych wersji → needs_reimport. */
router.post(
  '/:id/approve',
  asyncHandler((req, res) => {
    try {
      const { flaggedBatches } = approveProfile({
        id: req.params.id,
        adminUserId: req.userId!,
        note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      });
      res.json({ success: true, flaggedBatches });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  }),
);

/** POST /:id/reject — odrzucenie z notą. */
router.post(
  '/:id/reject',
  asyncHandler((req, res) => {
    try {
      rejectProfile({
        id: req.params.id,
        adminUserId: req.userId!,
        note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  }),
);

export default router;
