import { useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * Shared by every template picker (Step 2's full-page gallery, and the
 * per-step drawer in Design & Content) so the list is fetched the same way
 * in both places rather than duplicated.
 */
export function useTemplates() {
  const [templates, setTemplates] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [templatesData, categoriesData] = await Promise.all([
          api.get('/templates?withContent=1'),
          api.get('/templates/categories'),
        ]);
        setTemplates(templatesData.templates);
        setCategories(categoriesData.categories);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return { templates, categories, loading, error };
}
