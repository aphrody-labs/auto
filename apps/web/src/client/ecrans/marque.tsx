import { ReceiptText } from "@auto/ui/symboles";

export function Marque() {
  return (
    <a className="marque" href="/">
      <span className="marque-logo" aria-hidden="true">
        <ReceiptText className="icone" />
      </span>
      auto
    </a>
  );
}
