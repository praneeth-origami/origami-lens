/**
 * A structured, purpose-built PDF — not a browser printout. Built with
 * pdfkit (the one new dependency this feature adds; nothing else in the
 * monorepo can render a PDF) so every element (health-score badge, category
 * bars, severity tags, page numbers) is drawn precisely rather than laying
 * out an HTML page and printing it.
 */
import PDFDocument from 'pdfkit';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { IssueCategory, LensReport, Severity } from '@origami/contracts';
import { CATEGORY_LABEL } from '@origami/contracts';
import { isReportReady } from './report-service.js';

const BRAND = {
  primary: '#6d5ef6',
  text: '#111827',
  textMuted: '#667085',
  border: '#dfe7f1',
  background: '#f4f7fb',
  critical: '#dc2626',
  high: '#f97316',
  medium: '#d97706',
  low: '#2563eb',
} as const;

const SEVERITY_COLOR: Record<Severity, string> = {
  CRITICAL: BRAND.critical,
  HIGH: BRAND.high,
  MEDIUM: BRAND.medium,
  LOW: BRAND.low,
};

const here = path.dirname(fileURLToPath(import.meta.url));
/** Same brand-icon.png the email templates embed (apps/web/public/brand-icon.png) — the only artwork this repo has for the mark. Read lazily so a missing file only skips the logo, never breaks the report. */
const LOGO_PATH = path.resolve(here, '../../../apps/web/public/brand-icon.png');
let cachedLogo: Buffer | null | undefined;

async function loadLogo(): Promise<Buffer | undefined> {
  if (cachedLogo === null) return undefined;
  if (cachedLogo) return cachedLogo;
  try {
    cachedLogo = await readFile(LOGO_PATH);
    return cachedLogo;
  } catch (error) {
    console.error('[report-pdf-renderer] Could not read brand-icon.png:', error instanceof Error ? error.message : error);
    cachedLogo = null;
    return undefined;
  }
}

const MARGIN = 50;
const PAGE_WIDTH = 612; // US Letter, points
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function drawSectionDivider(doc: PDFKit.PDFDocument): void {
  doc.moveDown(0.5);
  doc.strokeColor(BRAND.border).lineWidth(1).moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y).stroke();
  doc.moveDown(0.75);
}

function drawCategoryBar(doc: PDFKit.PDFDocument, label: string, score: number, accentColor: string): void {
  const barY = doc.y;
  doc.fontSize(10).fillColor(BRAND.text).font('Helvetica-Bold').text(label, MARGIN, barY, { continued: false, width: 160 });
  const trackX = MARGIN + 170;
  const trackWidth = CONTENT_WIDTH - 170 - 40;
  doc.roundedRect(trackX, barY + 1, trackWidth, 8, 4).fillColor(BRAND.background).fill();
  const fillWidth = Math.max(4, (Math.min(100, Math.max(0, score)) / 100) * trackWidth);
  doc.roundedRect(trackX, barY + 1, fillWidth, 8, 4).fillColor(accentColor).fill();
  doc.fontSize(10).fillColor(BRAND.text).font('Helvetica-Bold').text(String(Math.round(score)), trackX + trackWidth + 10, barY, { width: 30 });
  doc.moveDown(1.1);
}

function drawFooter(doc: PDFKit.PDFDocument, report: LensReport, pageNumber: number, pageCount: number): void {
  const footerY = doc.page.height - 40;
  doc.fontSize(8).fillColor(BRAND.textMuted).font('Helvetica')
    .text(`${report.url}  ·  Generated ${new Date(report.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`, MARGIN, footerY, { width: CONTENT_WIDTH - 60, lineBreak: false })
    .text(`Page ${pageNumber} of ${pageCount}`, PAGE_WIDTH - MARGIN - 100, footerY, { width: 100, align: 'right', lineBreak: false });
}

export interface ReportPdfScreenshots {
  /** Raw JPEG bytes (read via ArtifactStore by the caller) — a PDF is a static document, so unlike the live web report it can't reference a screenshot by URL; this is the one place this renderer needs actual image bytes rather than a reference. */
  desktop?: Buffer;
  mobile?: Buffer;
}

/**
 * Agency plan (V4) white-label branding — `report.branding.displayName`/
 * `primaryColor` are already plain data on the report, but a PDF can't
 * reference the agency's logo by URL the way the live web report can (same
 * reasoning as ReportPdfScreenshots above), so the caller reads its actual
 * bytes via ArtifactStore and passes them here. Falls back to Origami
 * Lens's own hardcoded logo/name/primary color when absent (every
 * non-Agency report, or an Agency report with no logo uploaded yet) —
 * existing behavior is byte-for-byte unchanged in that case.
 */
export interface ReportPdfBrandingAssets {
  logo?: Buffer;
}

export async function renderReportPdf(report: LensReport, screenshots?: ReportPdfScreenshots, brandingAssets?: ReportPdfBrandingAssets): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const logo = brandingAssets?.logo ?? await loadLogo();
  const brandName = report.branding?.displayName?.toUpperCase() ?? 'ORIGAMI LENS';
  const brandPrimary = report.branding?.primaryColor ?? BRAND.primary;

  // ---- Cover section -----------------------------------------------------
  if (logo) doc.image(logo, MARGIN, MARGIN, { width: 32 });
  doc.fontSize(11).fillColor(brandPrimary).font('Helvetica-Bold').text(brandName, logo ? MARGIN + 42 : MARGIN, MARGIN + 6);
  doc.moveDown(1.4);
  doc.fontSize(20).fillColor(BRAND.text).font('Helvetica-Bold').text('Website Health Report');
  doc.moveDown(0.3);
  doc.fontSize(12).fillColor(BRAND.textMuted).font('Helvetica').text(report.url);
  doc.moveDown(0.2);
  const scannedLabel = report.scannedAt
    ? new Date(report.scannedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'N/A';
  doc.fontSize(10).fillColor(BRAND.textMuted).text(`Scan date: ${scannedLabel}`);
  drawSectionDivider(doc);

  if (!isReportReady(report.reportStatus)) {
    doc.fontSize(13).fillColor(BRAND.text).font('Helvetica-Bold').text('This scan did not complete successfully.');
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor(BRAND.textMuted).font('Helvetica').text(`Status: ${report.reportStatus}. No health score or issues are available for this report.`);
  } else {
    // ---- Health score ------------------------------------------------
    doc.fontSize(13).fillColor(BRAND.text).font('Helvetica-Bold').text('HEALTH SCORE');
    doc.moveDown(0.4);
    doc.fontSize(36).fillColor(brandPrimary).font('Helvetica-Bold').text(`${report.healthScore} / 100`);
    drawSectionDivider(doc);

    // ---- Category scores ----------------------------------------------
    doc.fontSize(13).fillColor(BRAND.text).font('Helvetica-Bold').text('CATEGORY SCORES');
    doc.moveDown(0.6);
    if (report.categories) {
      for (const [key, score] of Object.entries(report.categories) as [IssueCategory, number][]) {
        drawCategoryBar(doc, CATEGORY_LABEL[key], score, brandPrimary);
      }
    }
    drawSectionDivider(doc);

    // ---- Issue summary --------------------------------------------------
    doc.fontSize(13).fillColor(BRAND.text).font('Helvetica-Bold').text('ISSUE SUMMARY');
    doc.moveDown(0.5);
    const summaryY = doc.y;
    const summaryItems: [string, number, string][] = [
      ['Critical', report.summary.critical, BRAND.critical],
      ['Important', report.summary.important, BRAND.high],
      ['Improvements', report.summary.improvements, BRAND.low],
    ];
    summaryItems.forEach(([label, count, color], i) => {
      const x = MARGIN + i * (CONTENT_WIDTH / 3);
      doc.circle(x + 5, summaryY + 5, 4).fillColor(color).fill();
      doc.fontSize(11).fillColor(BRAND.text).font('Helvetica-Bold').text(`${count} ${label}`, x + 14, summaryY, { width: CONTENT_WIDTH / 3 - 14 });
    });
    doc.y = summaryY + 24;
    drawSectionDivider(doc);

    // ---- Screenshot ---------------------------------------------------
    if (screenshots?.desktop) {
      doc.fontSize(13).fillColor(BRAND.text).font('Helvetica-Bold').text('SCREENSHOT');
      doc.moveDown(0.5);
      try {
        const imageTop = doc.y;
        doc.image(screenshots.desktop, MARGIN, imageTop, { fit: [CONTENT_WIDTH, 320] });
        // pdfkit's image() does not advance doc.y like text() does — advance
        // by the fit box's max height (a safe upper bound on the actual
        // scaled-to-aspect-ratio height) so later content never overlaps it.
        doc.y = imageTop + 320 + 10;
      } catch (error) {
        console.error('[report-pdf-renderer] Could not embed desktop screenshot:', error instanceof Error ? error.message : error);
      }
      drawSectionDivider(doc);
    }

    // ---- Issues -----------------------------------------------------------
    doc.fontSize(13).fillColor(BRAND.text).font('Helvetica-Bold').text('ISSUES');
    doc.moveDown(0.5);
    for (const issue of report.issues) {
      if (doc.y > doc.page.height - 160) doc.addPage();
      doc.fontSize(11).fillColor(SEVERITY_COLOR[issue.severity]).font('Helvetica-Bold').text(`${issue.severity} — ${issue.title}`);
      doc.fontSize(9).fillColor(BRAND.textMuted).font('Helvetica').text(`Category: ${CATEGORY_LABEL[issue.category]}`);
      doc.moveDown(0.3);
      const field = (label: string, value: string) => {
        doc.fontSize(9.5).fillColor(BRAND.text).font('Helvetica-Bold').text(label);
        doc.fontSize(9.5).fillColor(BRAND.textMuted).font('Helvetica').text(value, { width: CONTENT_WIDTH });
        doc.moveDown(0.25);
      };
      field('Problem', issue.problem);
      field('Cause', issue.cause);
      field('Impact', issue.impact);
      field('Suggested Fix', issue.suggestedFix);
      if (issue.url) field('URL', issue.url);
      if (issue.selector) field('Selector', issue.selector);
      doc.moveDown(0.3);
      drawSectionDivider(doc);
    }
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    drawFooter(doc, report, i + 1, range.count);
  }

  doc.end();
  return done;
}
