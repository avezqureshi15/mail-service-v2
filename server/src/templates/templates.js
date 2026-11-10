import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import juice from 'juice';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let manifest = null;
const templateCache = new Map();

function loadManifest() {
  if (!manifest) {
    manifest = JSON.parse(readFileSync(join(__dirname, 'manifest.json'), 'utf-8'));
  }
  return manifest;
}

// Templates are authored with a <style> block and classes, like any normal
// web page. But the outgoing message is sanitized (see mail/compose.js),
// which strips both <style> content and class attributes - a template's
// design would otherwise disappear the moment a message is actually sent,
// even though it looks fine in the editor's unsanitized preview. Inlining
// here, once, at load time, means every CSS rule survives as a `style`
// attribute the sanitizer is allowed to keep.
function readTemplateFile(filename) {
  const path = join(__dirname, filename);
  const raw = readFileSync(path, 'utf-8');
  return juice(raw);
}

export function getTemplateList() {
  const m = loadManifest();
  return m.templates.map(template => ({
    id: template.id,
    name: template.name,
    description: template.description,
    category: template.category,
    colors: template.colors,
    bestFor: template.bestFor,
    features: template.features,
  }));
}

export function getTemplateCategories() {
  const m = loadManifest();
  return m.categories;
}

export function getTemplate(templateId) {
  const m = loadManifest();
  const templateMeta = m.templates.find(t => t.id === templateId);

  if (!templateMeta) {
    return null;
  }

  // Check cache
  if (templateCache.has(templateId)) {
    return templateCache.get(templateId);
  }

  // Load and cache
  const content = readTemplateFile(templateMeta.file);
  const result = {
    ...templateMeta,
    content,
  };

  templateCache.set(templateId, result);
  return result;
}

export function getAllTemplates() {
  const m = loadManifest();
  return m.templates.map(templateMeta => {
    const cached = templateCache.get(templateMeta.id);
    if (cached) {
      return cached;
    }

    const content = readTemplateFile(templateMeta.file);
    const result = {
      ...templateMeta,
      content,
    };

    templateCache.set(templateMeta.id, result);
    return result;
  });
}

export function getMergeFieldsGuide() {
  const m = loadManifest();
  return m.mergeFieldsGuide;
}

export function getTemplatesByCategory(categoryId) {
  const m = loadManifest();
  return m.templates
    .filter(t => t.category === categoryId)
    .map(template => ({
      id: template.id,
      name: template.name,
      description: template.description,
      colors: template.colors,
      bestFor: template.bestFor,
    }));
}

export function validateTemplate(templateId) {
  return getTemplate(templateId) !== null;
}

export function getTemplateMetadata(templateId) {
  const template = getTemplate(templateId);
  if (!template) {
    return null;
  }

  const { content, ...metadata } = template;
  return metadata;
}

export default {
  getTemplateList,
  getTemplateCategories,
  getTemplate,
  getAllTemplates,
  getMergeFieldsGuide,
  getTemplatesByCategory,
  validateTemplate,
  getTemplateMetadata,
};
