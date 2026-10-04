import { useState } from "react";
import { colorDeEmpresa, inicialDeEmpresa } from "../app/empresa-color.js";
import { cn } from "../ui/cn.js";

/**
 * LA INSIGNIA DE UNA EMPRESA (O-05): su logo si lo tiene; si no —o si la imagen no carga: la URL
 * del logo es firmada y de vigencia corta—, su inicial sobre el color derivado de la empresa.
 * La usan el selector, la cabecera y «Elige la empresa», para que las tres digan lo mismo.
 *
 * Es decoración: el nombre va siempre al lado, en texto, así que se oculta a los lectores de
 * pantalla en vez de repetirlo.
 */
export function InsigniaEmpresa({
  empresa,
  className,
}: {
  empresa: {
    readonly id: string;
    readonly trade_name: string | null;
    readonly legal_name: string;
    readonly logo_url: string | null;
  };
  className?: string;
}): React.JSX.Element {
  // La URL que falló, no un booleano: si llega otra (otra empresa, una firma nueva) se reintenta.
  const [fallo, setFallo] = useState<string | null>(null);
  const forma = cn("size-6 shrink-0 rounded-md", className);
  if (empresa.logo_url !== null && empresa.logo_url !== fallo) {
    const url = empresa.logo_url;
    return (
      <img
        src={url}
        alt=""
        aria-hidden
        onError={() => setFallo(url)}
        className={cn(forma, "border border-border bg-surface object-contain")}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ backgroundColor: colorDeEmpresa(empresa.id) }}
      className={cn(
        forma,
        "inline-flex items-center justify-center text-[0.78rem] font-semibold leading-none text-white",
      )}
    >
      {inicialDeEmpresa(empresa)}
    </span>
  );
}
