-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Academy LMS - Unique Indexes
-- ═══════════════════════════════════════════════════════════════════════════════
-- These indexes are created outside Drizzle ORM due to syntax limitations
--
-- EXISTENCE GUARDS (added when wiring up the migration runner)
--
-- These tables belong to kon-academy-lms, which is OPTIONAL. A migration
-- of the core cannot assume a kon is installed: on a clean
-- database without academy, the 15 indexes failed and with them the whole chain.
-- It is the same pattern rls-owned-tables.sql already uses.

-- ============================================
-- GROUPS AND ASSIGNMENTS
-- ============================================

-- A user can only be in a group once
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'grupo_usuarios'
  ) THEN
    EXECUTE $IDX$
      CREATE UNIQUE INDEX IF NOT EXISTS gu_pk ON grupo_usuarios (grupo_id, user_id);
    $IDX$;
  END IF;
END $$;

-- A supervisor can only be in a group once
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'grupo_supervisores'
  ) THEN
    EXECUTE $IDX$
      CREATE UNIQUE INDEX IF NOT EXISTS gs_pk ON grupo_supervisores (grupo_id, supervisor_id);
    $IDX$;
  END IF;
END $$;

-- ============================================
-- PROGRESS TRACKING
-- ============================================

-- A user can only have one progress per course
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'progreso_cursos'
  ) THEN
    EXECUTE $IDX$
      CREATE UNIQUE INDEX IF NOT EXISTS pr_usr_cur ON progreso_cursos (user_id, curso_id);
    $IDX$;
  END IF;
END $$;

-- A module can only appear once in a course's progress
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'progreso_modulos'
  ) THEN
    EXECUTE $IDX$
      CREATE UNIQUE INDEX IF NOT EXISTS pm_pk ON progreso_modulos (progreso_curso_id, modulo_id);
    $IDX$;
  END IF;
END $$;

-- A user can only have one progress per topic
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'progreso_temas'
  ) THEN
    EXECUTE $IDX$
      CREATE UNIQUE INDEX IF NOT EXISTS pr_usr_tem_prog ON progreso_temas (user_id, tema_id);
    $IDX$;
  END IF;
END $$;

-- ============================================
-- LEARNING PATHS
-- ============================================

-- A course can only appear once in a learning path
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'learning_path_cursos'
  ) THEN
    EXECUTE $IDX$
      CREATE UNIQUE INDEX IF NOT EXISTS lp_cur ON learning_path_cursos (learning_path_id, curso_id);
    $IDX$;
  END IF;
END $$;

-- A user can only have one progress per learning path
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'progreso_learning_paths'
  ) THEN
    EXECUTE $IDX$
      CREATE UNIQUE INDEX IF NOT EXISTS lp_usr ON progreso_learning_paths (user_id, learning_path_id);
    $IDX$;
  END IF;
END $$;

-- ============================================
-- FEEDBACK
-- ============================================

-- A user can only give one feedback per topic
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'feedback'
  ) THEN
    EXECUTE $IDX$
      CREATE UNIQUE INDEX IF NOT EXISTS fb_usr_tem ON feedback (user_id, tema_id);
    $IDX$;
  END IF;
END $$;

-- ============================================
-- ADDITIONAL PERFORMANCE INDEXES
-- ============================================

-- Indexes for common searches
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'progreso_cursos'
  ) THEN
    EXECUTE $IDX$
      CREATE INDEX IF NOT EXISTS pr_curso_id ON progreso_cursos (curso_id);
    $IDX$;
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'progreso_modulos'
  ) THEN
    EXECUTE $IDX$
      CREATE INDEX IF NOT EXISTS pr_modulo_id ON progreso_modulos (modulo_id);
    $IDX$;
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'progreso_temas'
  ) THEN
    EXECUTE $IDX$
      CREATE INDEX IF NOT EXISTS pr_tema_id ON progreso_temas (tema_id);
    $IDX$;
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'learning_path_cursos'
  ) THEN
    EXECUTE $IDX$
      CREATE INDEX IF NOT EXISTS lp_curso_id ON learning_path_cursos (curso_id);
    $IDX$;
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'feedback'
  ) THEN
    EXECUTE $IDX$
      CREATE INDEX IF NOT EXISTS fb_tema_id ON feedback (tema_id);
    $IDX$;
  END IF;
END $$;

-- Indexes for ordering by date
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'progreso_cursos'
  ) THEN
    EXECUTE $IDX$
      CREATE INDEX IF NOT EXISTS pr_fecha ON progreso_cursos (created_at DESC);
    $IDX$;
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'resultados_quiz'
  ) THEN
    EXECUTE $IDX$
      CREATE INDEX IF NOT EXISTS res_fecha ON resultados_quiz (fecha_realizacion DESC);
    $IDX$;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- NOTE: These indexes implement the uniqueness constraints that cannot be
-- defined directly in Drizzle ORM due to library limitations.
-- ═══════════════════════════════════════════════════════════════════════════════
