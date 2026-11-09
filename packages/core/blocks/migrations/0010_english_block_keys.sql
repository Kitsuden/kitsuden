-- 0010 — Block data keys in English
-- ============================================================================
-- Idempotent.
--
-- Up to 0.8 the data of several block types used Spanish keys (`titulo`, `descripcion`, `campos`,
-- `juegoDeCartas`…); 0.9 speaks English only. This rewrites the block JSON this kon stores:
--
--   block_contents.content    the blocks of every builder page
--   block_templates.content   the saved block presets
--
-- The table of renames is the one in `@kitsuden/shared` (packages/shared/src/block-keys.ts), which
-- the API also uses to read a 0.8 key that slipped through and to answer a 0.8 write with a 422.
-- `tests/unit/block-keys.test.ts` runs this file against that table.
--
-- The rule for each key: a Spanish key alone moves to its English name (a value from a closed list,
-- like `vista: "resumen"`, is translated with it); if the English key is already there it wins and
-- the Spanish one is dropped; nothing else is touched. Rows already in English do not change, so
-- running it twice is the same as running it once. No other JSON is read or written.
--
-- The helper functions live only while this migration runs (one file = one transaction).

CREATE OR REPLACE FUNCTION kitsuden_blocks_0010_rename(o jsonb, m jsonb, v jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  old_key text;
  new_key text;
  val jsonb;
BEGIN
  IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR m IS NULL THEN
    RETURN o;
  END IF;
  FOR old_key, new_key IN SELECT key, value #>> '{}' FROM jsonb_each(m) LOOP
    IF o ? old_key THEN
      IF NOT (o ? new_key) THEN
        val := o -> old_key;
        IF jsonb_typeof(val) = 'string' AND jsonb_typeof(v -> new_key) = 'object'
           AND (v -> new_key) ? (val #>> '{}') THEN
          val := (v -> new_key) -> (val #>> '{}');
        END IF;
        o := o || jsonb_build_object(new_key, val);
      END IF;
      o := o - old_key;
    END IF;
  END LOOP;
  RETURN o;
END
$fn$;

CREATE OR REPLACE FUNCTION kitsuden_blocks_0010_rename_list(a jsonb, m jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN jsonb_typeof(a) = 'array' THEN
    (SELECT coalesce(jsonb_agg(kitsuden_blocks_0010_rename(x, m) ORDER BY i), '[]'::jsonb)
       FROM jsonb_array_elements(a) WITH ORDINALITY AS t(x, i))
  ELSE a END
$fn$;

CREATE OR REPLACE FUNCTION kitsuden_blocks_0010_data(block_type text, d jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  common jsonb := '{"titulo":"title","subtitulo":"subtitle","descripcion":"description","nota":"note"}';
  by_type jsonb := '{
    "comments": {"orden":"order"},
    "dex": {"segmento":"segment","campos":"fields","facetas":"facets","habilidades":"skills","rasgo":"trait","evolucion":"evolution","noticias":"news"},
    "affinity": {"campos":"fields","etiquetas":"labels"},
    "event-search": {"campos":"fields"},
    "race-planner": {"campos":"fields"},
    "card-browser": {"juegoDeCartas":"cardGame","facetas":"facets"},
    "deck-builder": {"juegoDeCartas":"cardGame"},
    "deck-showcase": {"juegoDeCartas":"cardGame"},
    "deck": {"juego":"game","arquetipo":"archetype","mazo":"deck","vista":"view"}
  }';
  vals jsonb := '{
    "comments": {"order": {"mejores":"best","nuevos":"newest","antiguos":"oldest"}},
    "deck": {"view": {"resumen":"summary","lista":"list"}}
  }';
  field_keys jsonb := '{"clave":"key","nombre":"name","imagen":"image","icono":"icon","numero":"number","grupos":"groups","opciones":"options","descripcion":"description","fuente":"source"}';
  item_keys jsonb := '{"campo":"field","etiqueta":"label","herramienta":"tool"}';
  linked_keys jsonb := '{"campo":"field","clave":"key","nombre":"name","imagen":"image","icono":"icon","grupos":"groups"}';
  label_keys jsonb := '{"progenitor":"parent"}';
  -- Which nested container of each type holds renamed keys: object, list of objects, linked dataset.
  nested jsonb := '{
    "dex": {"fields":"fields","facets":"items","chips":"items","skills":"linked","trait":"linked","evolution":"linked","news":"linked"},
    "affinity": {"fields":"fields","labels":"labels"},
    "event-search": {"fields":"fields"},
    "race-planner": {"fields":"fields"},
    "card-browser": {"facets":"items"}
  }';
  container text;
  kind text;
  inner_value jsonb;
BEGIN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' THEN
    RETURN d;
  END IF;
  d := kitsuden_blocks_0010_rename(d, common);
  d := kitsuden_blocks_0010_rename(d, by_type -> block_type, vals -> block_type);
  FOR container, kind IN SELECT key, value #>> '{}' FROM jsonb_each(coalesce(nested -> block_type, '{}'::jsonb)) LOOP
    CONTINUE WHEN NOT (d ? container);
    inner_value := d -> container;
    IF kind = 'items' THEN
      inner_value := kitsuden_blocks_0010_rename_list(inner_value, item_keys);
    ELSIF kind = 'fields' THEN
      inner_value := kitsuden_blocks_0010_rename(inner_value, field_keys);
    ELSIF kind = 'labels' THEN
      inner_value := kitsuden_blocks_0010_rename(inner_value, label_keys);
    ELSIF kind = 'linked' THEN
      inner_value := kitsuden_blocks_0010_rename(inner_value, linked_keys);
      IF jsonb_typeof(inner_value) = 'object' AND jsonb_typeof(inner_value -> 'groups') = 'array' THEN
        inner_value := jsonb_set(inner_value, '{groups}',
          kitsuden_blocks_0010_rename_list(inner_value -> 'groups', item_keys));
      END IF;
    END IF;
    d := jsonb_set(d, ARRAY[container], inner_value);
  END LOOP;
  RETURN d;
END
$fn$;

UPDATE block_contents
   SET content = kitsuden_blocks_0010_data(type::text, content)
 WHERE content IS DISTINCT FROM kitsuden_blocks_0010_data(type::text, content);

UPDATE block_templates
   SET content = kitsuden_blocks_0010_data(type::text, content)
 WHERE content IS DISTINCT FROM kitsuden_blocks_0010_data(type::text, content);

DROP FUNCTION kitsuden_blocks_0010_data(text, jsonb);
DROP FUNCTION kitsuden_blocks_0010_rename_list(jsonb, jsonb);
DROP FUNCTION kitsuden_blocks_0010_rename(jsonb, jsonb, jsonb);
