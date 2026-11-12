-- Reprise persistée d’une relève bornée, sans modifier les migrations déjà appliquées.
ALTER TABLE source_fichiers ADD COLUMN curseur text;
