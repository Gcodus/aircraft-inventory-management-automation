// Load environment
import dotenv from 'dotenv';
dotenv.config();

// Imports
import express from 'express';
import { neon } from '@neondatabase/serverless';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve __dirname for ES modulesss
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Create app
const app = express();
app.use(express.json());

// Serve /docs as static 
app.use(express.static(path.join(__dirname, 'docs')));

// Neon Postgres connection
const sql = neon(process.env.DATABASE_URL);

// Debugging & root
app.get('/env', (_req, res) => {
  res.json({ DATABASE_URL: process.env.DATABASE_URL || null });
});
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'docs', 'inventory.html'));
});
app.get('/health', async (_req, res) => {
  try { await sql`SELECT 1`; res.json({ ok: true }); }
  catch (e) { console.error('Health check DB error:', e?.message); res.status(500).json({ ok: false, error: 'db_unreachable' }); }
});

// Routes helper
app.get('/routes', (_req, res) => {
  res.json({
    ok: true,
    routes: [
      '/', '/env', '/health',
      // items
      '/api/items',                // GET list
      '/api/items/:batchId',       // PUT update qty, DELETE batch
      '/api/items/:batchId/adjust',// PATCH +/- adjust with movement
      // workorders look again
      '/api/workorders',                   // GET list, POST create
      '/api/workorders/:id',               // DELETE wo
      '/api/workorders/:id/status',        // PUT status
      '/api/workorders/:id/lines',         // GET/POST lines
      '/api/workorders/:id/lines/:lineId', // DELETE line
      '/api/workorders/:id/lines/:lineId/issue',  // POST issue
      '/api/workorders/:id/lines/:lineId/return', // POST return
      // settingsss
      '/api/settings',              // GET, PUT upsert
      // reportsss
      '/api/reports/lowstock',
      // movementsss
      '/api/movements'
    ]
  });
});

/* ITEMS & BATCHES */

// GET items + batches 
app.get('/api/items', async (_req, res) => {
  try {
    const rows = await sql`
      SELECT
        i.id           AS item_id,
        i.part_number,
        b.id           AS batch_id,
        b.batch_number,
        b.quantity
      FROM items i
      LEFT JOIN batches b ON b.item_id = i.id
      ORDER BY i.part_number, b.batch_number NULLS LAST
    `;
    res.json(rows);
  } catch (err) {
    console.error('GET /api/items error:', err);
    res.status(500).json({ error: 'DB query failed' });
  }
});

// POST create/upsert item + batc - should add to existing 1
app.post('/api/items', async (req, res) => {
  try {
    const { part_number, batch_number, quantity = 0 } = req.body || {};
    if (!part_number || !batch_number) {
      return res.status(400).json({ ok: false, error: 'part_number_and_batch_required' });
    }

    // Find-or-create item
    let itemId;
    const found = await sql`SELECT id FROM items WHERE part_number = ${part_number} LIMIT 1`;
    if (found.length) {
      itemId = found[0].id;
    } else {
      const ins = await sql`INSERT INTO items (part_number) VALUES (${part_number}) RETURNING id`;
      itemId = ins[0].id;
    }

    // Upsert batch: on conflict (item_id,batch_number) to add to quantity
    const batchRows = await sql`
      INSERT INTO batches (item_id, batch_number, quantity, condition)
      VALUES (${itemId}, ${batch_number}, ${Number(quantity) || 0}, 'NEW')
      ON CONFLICT (item_id, batch_number) DO UPDATE
        SET quantity = batches.quantity + EXCLUDED.quantity
      RETURNING id
    `;

    res.json({ ok: true, data: { item_id: itemId, batch_id: batchRows[0].id } });
  } catch (err) {
    console.error('POST /api/items error:', err);
    res.status(400).json({ ok: false, error: 'insert_failed' });
  }
});

// PUT set batch quantity (absolute)
app.put('/api/items/:batchId', async (req, res) => {
  try {
    const batchId = String(req.params.batchId);
    const qty = Number(req.body?.quantity);
    if (!/^\d+$/.test(batchId) || !Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({ ok: false, error: 'invalid_input' });
    }
    await sql`UPDATE batches SET quantity = ${qty} WHERE id = ${batchId}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/items/:batchId error:', err);
    res.status(400).json({ ok: false, error: 'update_failed' });
  }
});

// PATCH adjust batch quantitywith movement logloglog
app.patch('/api/items/:batchId/adjust', async (req, res) => {
  try {
    const batchId = String(req.params.batchId);
    const qty_change = Number(req.body?.qty_change);
    const reason = req.body?.reason || 'Manual adjust';
    if (!/^\d+$/.test(batchId) || !Number.isFinite(qty_change) || qty_change === 0) {
      return res.status(400).json({ ok: false, error: 'invalid_input' });
    }

    const rows = await sql`
      SELECT b.id AS batch_id, b.item_id, b.quantity AS onhand
      FROM batches b
      WHERE b.id = ${batchId}
      LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ ok:false, error:'batch_not_found' });

    if (rows[0].onhand + qty_change < 0) {
      return res.status(400).json({ ok:false, error:'insufficient_stock' });
    }

    await sql`UPDATE batches SET quantity = quantity + ${qty_change} WHERE id = ${batchId}`;
    await sql`
      INSERT INTO stock_movements (item_id, batch_id, movement_type, qty_change, reason)
      VALUES (${rows[0].item_id}, ${batchId}, 'ADJUST', ${qty_change}, ${reason})
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/items/:batchId/adjust error:', err);
    res.status(400).json({ ok:false, error:'adjust_failed' });
  }
});

// DELETE batch
app.delete('/api/items/:batchId', async (req, res) => {
  try {
    const batchId = String(req.params.batchId);
    if (!/^\d+$/.test(batchId)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    await sql`DELETE FROM batches WHERE id = ${batchId}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/items/:batchId error:', err);
    res.status(400).json({ ok: false, error: 'delete_failed' });
  }
});

/* Work Orders */

// GET WOs (optional ?q=)
app.get('/api/workorders', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const rows = q
      ? await sql`
          SELECT id, code, status, requested_by, created_at
          FROM workorders
          WHERE code ILIKE ${'%' + q + '%'}
             OR status ILIKE ${'%' + q + '%'}
             OR requested_by ILIKE ${'%' + q + '%'}
          ORDER BY created_at DESC
          LIMIT 250
        `
      : await sql`
          SELECT id, code, status, requested_by, created_at
          FROM workorders
          ORDER BY created_at DESC
          LIMIT 250
        `;
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /api/workorders error:', err);
    res.status(500).json({ ok: false, error: 'db_error' });
  }
});

// POST create WO (auto 5-digit code if none)
app.post('/api/workorders', async (req, res) => {
  try {
    let { code, status = 'draft', requested_by = null } = req.body || {};
    if (!['draft','issued','closed'].includes(status)) status = 'draft';

    if (!code) {
      // Unique WO 5 num,bers
      let tries = 0, generated, exists = true;
      while (exists && tries < 8) {
        generated = 'WO-' + String(Math.floor(100000 + Math.random()*900000)).slice(1); // 5 numbers
        const chk = await sql`SELECT 1 FROM workorders WHERE code = ${generated} LIMIT 1`;
        exists = chk.length > 0;
        tries++;
      }
      code = generated;
    }

    const rows = await sql`
      INSERT INTO workorders (code, status, requested_by)
      VALUES (${code}, ${status}, ${requested_by})
      RETURNING id, code, status, requested_by, created_at
    `;
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/workorders error:', err);
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('duplicate') || msg.includes('unique')) {
      return res.status(400).json({ ok: false, error: 'code_exists' });
    }
    res.status(400).json({ ok: false, error: 'insert_failed' });
  }
});

// DELETE WO
app.delete('/api/workorders/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!/^\d+$/.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
    await sql`DELETE FROM workorders WHERE id = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/workorders/:id error:', err);
    res.status(400).json({ ok: false, error: 'delete_failed' });
  }
});

// PUT WO status
app.put('/api/workorders/:id/status', async (req, res) => {
  try {
    const id = String(req.params.id);
    const newStatus = String(req.body?.status || 'draft');
    if (!/^\d+$/.test(id) || !['draft','issued','closed'].includes(newStatus)) {
      return res.status(400).json({ ok: false, error: 'invalid_input' });
    }
    await sql`UPDATE workorders SET status = ${newStatus} WHERE id = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/workorders/:id/status error:', err);
    res.status(400).json({ ok: false, error: 'status_failed' });
  }
});

// GET lines for a WO
app.get('/api/workorders/:id/lines', async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!/^\d+$/.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });

    const rows = await sql`
      SELECT
        wl.id AS line_id, wl.qty_requested, wl.qty_issued, wl.note,
        i.id AS item_id, i.part_number,
        b.id AS batch_id, b.batch_number, b.quantity AS onhand
      FROM workorder_lines wl
      JOIN items i  ON i.id = wl.item_id
      JOIN batches b ON b.id = wl.batch_id
      WHERE wl.workorder_id = ${id}
      ORDER BY wl.id DESC
    `;
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /api/workorders/:id/lines error:', err);
    res.status(500).json({ ok: false, error: 'db_error' });
  }
});

// POST add line to WO
app.post('/api/workorders/:id/lines', async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!/^\d+$/.test(id)) return res.status(400).json({ ok: false, error: 'invalid_wo' });

    let { part_number, batch_number, qty, item_id, batch_id, note = null } = req.body || {};
    qty = Number(qty);
    if (!qty || qty <= 0) return res.status(400).json({ ok: false, error: 'qty_required' });

    // Resolve item+batch if pn/batch provided
    if (!item_id || !batch_id) {
      const rows = await sql`
        SELECT i.id AS item_id, b.id AS batch_id
        FROM items i
        JOIN batches b ON b.item_id = i.id
        WHERE i.part_number = ${part_number} AND b.batch_number = ${batch_number}
        LIMIT 1
      `;
      if (!rows.length) return res.status(404).json({ ok: false, error: 'item_batch_not_found' });
      item_id = rows[0].item_id;
      batch_id = rows[0].batch_id;
    }

    const ins = await sql`
      INSERT INTO workorder_lines (workorder_id, item_id, batch_id, qty_requested, note)
      VALUES (${id}, ${item_id}, ${batch_id}, ${qty}, ${note})
      RETURNING id
    `;
    res.json({ ok: true, data: { line_id: ins[0].id } });
  } catch (err) {
    console.error('POST /api/workorders/:id/lines error:', err);
    res.status(400).json({ ok: false, error: 'insert_failed' });
  }
});

// DELETE line
app.delete('/api/workorders/:id/lines/:lineId', async (req, res) => {
  try {
    const { id, lineId } = req.params;
    if (!/^\d+$/.test(id) || !/^\d+$/.test(lineId)) {
      return res.status(400).json({ ok: false, error: 'invalid_id' });
    }
    await sql`DELETE FROM workorder_lines WHERE id = ${lineId} AND workorder_id = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/workorders/:id/lines/:lineId error:', err);
    res.status(400).json({ ok: false, error: 'delete_failed' });
  }
});

// POST issue qty for a line 
app.post('/api/workorders/:id/lines/:lineId/issue', async (req, res) => {
  try {
    const { id, lineId } = req.params;
    const qty = Number(req.body?.qty);
    if (!/^\d+$/.test(id) || !/^\d+$/.test(lineId) || !qty || qty <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_input' });
    }

    const [line] = await sql`
      SELECT wl.id, wl.item_id, wl.batch_id, wl.qty_requested, wl.qty_issued,
             b.quantity AS onhand
      FROM workorder_lines wl
      JOIN batches b ON b.id = wl.batch_id
      WHERE wl.id = ${lineId} AND wl.workorder_id = ${id}
      LIMIT 1
    `;
    if (!line) return res.status(404).json({ ok: false, error: 'line_not_found' });
    if (line.onhand < qty) return res.status(400).json({ ok: false, error: 'insufficient_stock' });

    await sql`UPDATE batches SET quantity = quantity - ${qty} WHERE id = ${line.batch_id}`;
    await sql`
      INSERT INTO stock_movements (item_id, batch_id, movement_type, qty_change, reason)
      VALUES (${line.item_id}, ${line.batch_id}, 'ISSUE', ${-qty}, ${'WO-' + id})
    `;
    await sql`UPDATE workorder_lines SET qty_issued = qty_issued + ${qty} WHERE id = ${lineId}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/workorders/:id/lines/:lineId/issue error:', err);
    res.status(400).json({ ok: false, error: 'issue_failed' });
  }
});

// POST return qty for a line 
app.post('/api/workorders/:id/lines/:lineId/return', async (req, res) => {
  try {
    const { id, lineId } = req.params;
    const qty = Number(req.body?.qty);
    if (!/^\d+$/.test(id) || !/^\d+$/.test(lineId) || !qty || qty <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_input' });
    }

    const [line] = await sql`
      SELECT wl.id, wl.item_id, wl.batch_id, wl.qty_issued
      FROM workorder_lines wl
      WHERE wl.id = ${lineId} AND wl.workorder_id = ${id}
      LIMIT 1
    `;
    if (!line) return res.status(404).json({ ok: false, error: 'line_not_found' });
    if (line.qty_issued < qty) return res.status(400).json({ ok: false, error: 'too_much_return' });

    await sql`UPDATE batches SET quantity = quantity + ${qty} WHERE id = ${line.batch_id}`;
    await sql`
      INSERT INTO stock_movements (item_id, batch_id, movement_type, qty_change, reason)
      VALUES (${line.item_id}, ${line.batch_id}, 'RETURN', ${+qty}, ${'WO-' + id})
    `;
    await sql`UPDATE workorder_lines SET qty_issued = qty_issued - ${qty} WHERE id = ${lineId}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/workorders/:id/lines/:lineId/return error:', err);
    res.status(400).json({ ok: false, error: 'return_failed' });
  }
});

/* Settings duh */

app.get('/api/settings', async (_req, res) => {
  try {
    const rows = await sql`SELECT key, value FROM app_settings ORDER BY key`;
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /api/settings error:', err);
    res.status(500).json({ ok: false, error: 'db_error' });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const data = req.body || {};
    const keys = Object.keys(data);
    if (!keys.length) return res.status(400).json({ ok: false, error: 'no_data' });

    for (const k of keys) {
      await sql`
        INSERT INTO app_settings (key, value)
        VALUES (${k}, ${data[k]})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/settings error:', err);
    res.status(400).json({ ok: false, error: 'save_failed' });
  }
});

/* REPOrts */

app.get('/api/reports/lowstock', async (_req, res) => {
  try {
    const setting = await sql`SELECT value FROM app_settings WHERE key = 'low_stock_default'`;
    const threshold = parseInt(setting?.[0]?.value || '0', 10);

    const rows = await sql`
      SELECT i.part_number, b.batch_number, b.quantity, b.location, b.site, b.bin
      FROM batches b
      JOIN items i ON b.item_id = i.id
      WHERE b.quantity <= ${threshold}
      ORDER BY b.quantity ASC
    `;
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /api/reports/lowstock error:', err);
    res.status(500).json({ ok: false, error: 'db_error' });
  }
});

/* Movements */
app.get('/api/movements', async (_req, res) => {
  try {
    const rows = await sql`
      SELECT
        m.id,
        m.created_at,
        m.movement_type,
        m.qty_change,
        m.reason,
        i.part_number,
        b.batch_number
      FROM stock_movements m
      JOIN items   i ON i.id = m.item_id
      LEFT JOIN batches b ON b.id = m.batch_id
      ORDER BY m.created_at DESC
      LIMIT 200
    `;
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /api/movements error:', err);
    res.status(500).json({ ok: false, error: 'db_error' });
  }
});

// Start Serber
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server listening at http://localhost:${port}`);
});
