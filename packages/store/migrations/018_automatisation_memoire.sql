-- Mémoire d'un workflow d'une exécution à l'autre (nœud « Seulement les nouveaux » : valeurs déjà vues).
ALTER TABLE automatisation ADD COLUMN memoire jsonb NOT NULL DEFAULT '{}';
