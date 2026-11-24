import pool from './pool.js';

export async function insertBrandTemplateDb({ name, pptxPath, colors, fonts, uploadedBy = null }) {
  const res = await pool.query(
    `INSERT INTO brand_templates (name, pptx_path, colors, fonts, uploaded_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, pptxPath, JSON.stringify(colors), JSON.stringify(fonts), uploadedBy],
  );
  return res.rows[0].id;
}

export async function listBrandTemplatesDb() {
  const res = await pool.query('SELECT id, name, pptx_path, colors, fonts FROM brand_templates ORDER BY created_at');
  return res.rows;
}

export async function getBrandTemplateDb(id) {
  const res = await pool.query('SELECT id, name, pptx_path, colors, fonts, uploaded_by FROM brand_templates WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function deleteBrandTemplateDb(id) {
  const res = await pool.query('DELETE FROM brand_templates WHERE id = $1 RETURNING pptx_path', [id]);
  return res.rows[0] || null;
}
