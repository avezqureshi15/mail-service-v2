import { Router } from 'express';
import { z } from 'zod';
import {
  getTemplateList,
  getTemplate,
  getTemplateCategories,
  getTemplatesByCategory,
  getMergeFieldsGuide,
} from '../templates/templates.js';
import { validate } from '../middleware/index.js';

export const templatesRouter = Router();

/**
 * The list is metadata only by default, since that is all most callers need.
 * `?withContent=1` includes each template's HTML so the picker can render a
 * real thumbnail of it - about 50KB for the full set, which is cheaper than
 * one request per template and far cheaper than asking people to choose a
 * design from a written description of it.
 */
templatesRouter.get('/', validate(z.object({
  withContent: z.enum(['0', '1', 'true', 'false']).optional(),
}), 'query'), (req, res) => {
  const withContent = ['1', 'true'].includes(req.validatedQuery?.withContent ?? '');
  const templates = getTemplateList().map((template) => (
    withContent
      ? { ...template, content: getTemplate(template.id)?.content ?? '' }
      : template
  ));
  res.json({ templates });
});

templatesRouter.get('/categories', (req, res) => {
  const categories = getTemplateCategories();
  res.json({ categories });
});

templatesRouter.get('/merge-fields', (req, res) => {
  const fields = getMergeFieldsGuide();
  res.json({ fields });
});

templatesRouter.get('/by-category/:categoryId', validate(z.object({
  categoryId: z.string(),
}), 'params'), (req, res) => {
  const templates = getTemplatesByCategory(req.validatedParams.categoryId);
  if (templates.length === 0) {
    return res.status(404).json({ error: 'Category not found' });
  }
  res.json({ templates });
});

templatesRouter.get('/:templateId', validate(z.object({
  templateId: z.string(),
}), 'params'), (req, res) => {
  const template = getTemplate(req.validatedParams.templateId);
  if (!template) {
    return res.status(404).json({ error: 'Template not found' });
  }
  res.json({ template });
});
