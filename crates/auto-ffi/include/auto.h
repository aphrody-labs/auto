#ifndef APHRODY_AUTO_FFI_H
#define APHRODY_AUTO_FFI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Executes an Auto operation (`render_pdf`, `facturx`, `xml_cii`, `extract_xml`,
 * `verify_pdfa`, `read_spreadsheet`, `write_xlsx`, `modify_xlsx`, `merge_pdfs`,
 * `extract_pdf`, `pdf_page_count`, `pdf_text`, `create_docx`, `read_docx`,
 * `template_fields_docx`, `fill_template_docx`, `replace_docx`, `docx_text`,
 * `docx_to_pdf`, `redact_pdf`, `sign_pdf`, `verify_signatures`, `create_pptx`,
 * `pptx_text`, `pptx_to_pdf`, `chunk_text`, `nearest_vectors`,
 * `auth_hash_password`, `auth_verify_password`, `auth_sign_jwt`,
 * `auth_verify_jwt`, `auth_jwks`, `auth_seal_secret`, `auth_open_secret`,
 * `auth_totp_code`, `auth_totp_verify`, `auth_sign_token`, `auth_verify_token`,
 * `auth_generate_api_key`, `auth_verify_passkey`, `auth_can_perform`).
 *
 * Returns a heap buffer formatted as `[status_byte, ...payload_bytes]` where
 * `status_byte == 0` indicates success and `status_byte == 1` indicates UTF-8
 * error message. Caller MUST release non-null buffers via `auto_free(ptr, len)`.
 */
uint8_t *auto_call(
    const uint8_t *op_ptr,
    size_t op_len,
    const uint8_t *in_ptr,
    size_t in_len,
    size_t *out_len
);

/* Releases a buffer allocated by `auto_call`. */
void auto_free(uint8_t *ptr, size_t len);

/* Returns static NUL-terminated UTF-8 library version string. */
const char *auto_version(void);

#ifdef __cplusplus
}
#endif

#endif /* APHRODY_AUTO_FFI_H */
