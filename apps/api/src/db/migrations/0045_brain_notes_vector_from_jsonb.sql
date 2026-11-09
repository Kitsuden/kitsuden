-- ============================================================================
-- 0045 — brain_notes: sync embedding_vector without casting jsonb to vector
-- ============================================================================
--
-- The 0024 trigger did `NEW.embedding::VECTOR(384)`. In Postgres there is NO
-- cast from jsonb to vector, so with pgvector installed (and the
-- `embedding_vector` column created) EVERY INSERT into brain_notes failed with
-- "cannot cast type jsonb to vector". Without pgvector the trigger never reached
-- that line and nobody noticed.
--
-- Fix: go through text (`'[0.1, 0.2]'` is exactly the literal that vector
-- accepts) and only when the array has 384 numbers; the default value
-- `'[]'` or an embedding of another dimension leaves the column NULL instead of
-- bringing down the write. The JSONB remains the source of truth.
--
-- Without pgvector the function touches nothing (nor does it compile references to VECTOR at
-- creation time: PL/pgSQL resolves the type at execution, and that branch is not
-- executed). Idempotent: CREATE OR REPLACE of the function; the 0024 trigger
-- already points to it by name, and it is recreated in case it is missing.

CREATE OR REPLACE FUNCTION sync_brain_notes_embedding_vector()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
       AND EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'brain_notes' AND column_name = 'embedding_vector'
       ) THEN
        IF NEW.embedding IS NOT NULL
           AND jsonb_typeof(NEW.embedding) = 'array'
           AND jsonb_array_length(NEW.embedding) = 384 THEN
            NEW.embedding_vector := (NEW.embedding::text)::VECTOR(384);
        ELSE
            NEW.embedding_vector := NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_brain_notes_embedding_vector ON brain_notes;
CREATE TRIGGER trigger_brain_notes_embedding_vector
    BEFORE INSERT OR UPDATE ON brain_notes
    FOR EACH ROW
    EXECUTE FUNCTION sync_brain_notes_embedding_vector();
