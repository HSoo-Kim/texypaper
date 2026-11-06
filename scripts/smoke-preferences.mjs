import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { parseArgs, requireBinary, createRun, launchDesktop, waitFor, assert, writeJson } from './smoke-support.mjs';
import { configurePreferenceFixtures, verifyResetPreferences, exerciseOptionalUpdateFeed } from './smoke-desktop.mjs';

const args = parseArgs();
const binary = await requireBinary(args);
const run = await createRun(args, 'preferences');
const report = { passed: false, screenshots: [], evidence: [] };
let app;
try {
  app = await launchDesktop({ binary, ...run });
  for (const locale of ['ko', 'en']) {
    for (const theme of ['light', 'dark']) {
      await app.page.getByTestId('settings-button').click();
      await app.page.getByTestId('ui-locale').selectOption(locale);
      await app.page.getByTestId('ui-theme').selectOption(theme);
      await waitFor(() => app.page.evaluate(({ locale, theme }) => document.documentElement.lang === locale && document.documentElement.dataset.theme === theme, { locale, theme }), { label: `${locale}/${theme} real rendered preference state` });
      const image = `${locale}-${theme}-settings.png`;
      await app.page.screenshot({ path: path.join(run.output, image) });
      report.screenshots.push(image);
      await app.page.keyboard.press('Escape');
      assert(await app.page.getByTestId('workspace-open').innerText() === (locale === 'ko' ? '프로젝트 열기' : 'Open project'), 'The actual project action was not translated.');
    }
  }
  await app.page.getByTestId('settings-button').click();
  await app.page.getByTestId('ui-theme').selectOption('system');
  await app.page.emulateMedia({ colorScheme: 'light' });
  await waitFor(() => app.page.evaluate(() => document.documentElement.dataset.theme === 'light'), { label: 'system day theme' });
  await app.page.emulateMedia({ colorScheme: 'dark' });
  await waitFor(() => app.page.evaluate(() => document.documentElement.dataset.theme === 'dark'), { label: 'system night theme' });
  await app.page.keyboard.press('Escape');
  report.evidence.push(await configurePreferenceFixtures(app.page, run));
  await app.page.getByTestId('settings-button').click();
  await app.page.getByTestId('ui-locale').selectOption('en');
  await app.page.keyboard.press('Escape');
  await waitFor(async () => {
    const saved = JSON.parse(await readFile(path.join(run.dataDir, 'settings.json'), 'utf8'));
    return saved.locale === 'en' && saved.theme === 'dark' && saved.palettes.dark.action === '#83b9ff';
  }, { label: 'real saved language/night/custom color settings' });
  await app.close(); app = null;
  const restart = path.join(run.output, 'restart'); await mkdir(restart);
  app = await launchDesktop({ binary, output: restart, dataDir: run.dataDir });
  await waitFor(() => app.page.evaluate(() => document.documentElement.lang === 'en' && document.documentElement.dataset.theme === 'dark'), { label: 'real executable restored language and theme' });
  report.evidence.push(await verifyResetPreferences(app.page, run));
  report.update = await exerciseOptionalUpdateFeed(app.page, args, run.output, run.dataDir);
  if (args.updateFeed) {
    await app.close(); app = null;
    const updateRestart = path.join(run.output, 'update-restart'); await mkdir(updateRestart);
    app = await launchDesktop({ binary, output: updateRestart, dataDir: run.dataDir });
    await waitFor(async () => (await app.page.getByTestId('update-notice').innerText()).includes(args.updateVersion), { label: 'cached release notice after real executable restart' });
    await app.page.screenshot({ path: path.join(updateRestart, 'persistent-bottom-release.png') });
    report.evidence.push({ releasePersistsAcrossRestart: true });
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  await app?.page.screenshot({ path: path.join(run.output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeJson(path.join(run.output, 'preferences-results.json'), report);
  await app?.close();
}
