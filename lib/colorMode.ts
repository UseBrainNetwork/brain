/** Shared between the server layout (boot script) and the client toggle. No "use client" here on purpose. */
export const MODE_KEY = "brain-color-mode";

/**
 * Inline <head> script. Runs before paint so the first frame is already in the
 * right mode. Mirrors readPref/resolve in components/layout/ModeToggle.tsx.
 */
export const MODE_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(MODE_KEY)});var d=p==="dark"||(p!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.mode=d?"dark":"light"}catch(e){}})()`;
