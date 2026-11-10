#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${CC_WASM:=clang}"
build_one() {
"$CC_WASM" --target=wasm32 -O3 "$@" -nostdlib -fno-builtin -ffp-contract=off \
  -Wl,--no-entry -Wl,--export-memory \
  -Wl,--initial-memory=2097152 -Wl,--max-memory=536870912 \
  -Wl,--export=mcd_init -Wl,--export=mcd_version \
  -Wl,--export=mcd_input_ptr -Wl,--export=mcd_corr_ptr \
  -Wl,--export=mcd_lag_ptr -Wl,--export=mcd_trace_ptr \
  -Wl,--export=mcd_parameters_ptr -Wl,--export=mcd_tuning_ptr -Wl,--export=mcd_debug_ptr \
  -Wl,--export=mcd_set_tuning -Wl,--export=mcd_default_parameters \
  -Wl,--export=mcd_simd -Wl,--export=mcd_quadrature_nodes \
  -Wl,--export=mcd_pixels -Wl,--export=mcd_state_bytes -Wl,--export=mcd_memory_bytes \
  -Wl,--export=mcd_steps -Wl,--export=mcd_reset -Wl,--export=mcd_prime \
  -Wl,--export=mcd_step -Wl,--export=mcd_step_cut -Wl,--export=mcd_set_probe -o "$OUT" src/mcd.c
}
OUT=mcd.wasm build_one -msimd128
OUT=mcd-scalar.wasm build_one
printf 'Compiled state-transition MCD: %s bytes\n' "$(wc -c < mcd.wasm)"
