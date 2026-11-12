-- Console opérateur : suspension d'un tenant (impayé, abus). Un tenant suspendu ne s'authentifie plus ;
-- ses données restent intactes et la suspension se lève à tout moment.
ALTER TABLE tenant ADD COLUMN suspendu_at timestamptz;
ALTER TABLE tenant ADD COLUMN suspension_motif text;
