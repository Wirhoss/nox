CREATE VIRTUAL TABLE `history_fts` USING fts5(text, session_id UNINDEXED, message_id UNINDEXED, seq UNINDEXED, chunk_index UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
