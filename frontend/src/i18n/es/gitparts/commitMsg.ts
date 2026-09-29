// Textos de git.commitMsg. Ver .claude/specs/i18n.md.
// Los tipos (feat, fix…) son los de Conventional Commits y no se traducen;
// sí su descripción.
export default {
    types: {
        feat: {label: 'feat — funcionalidad nueva', hint: 'Agrega una capacidad que antes no existía'},
        fix: {label: 'fix — corrección', hint: 'Arregla un comportamiento incorrecto'},
        docs: {label: 'docs — documentación', hint: 'Solo documentación, sin cambios de código'},
        refactor: {label: 'refactor — reestructura', hint: 'Cambia cómo está escrito sin cambiar qué hace'},
        perf: {label: 'perf — rendimiento', hint: 'Mejora de performance'},
        test: {label: 'test — pruebas', hint: 'Agrega o corrige pruebas'},
        build: {label: 'build — build/dependencias', hint: 'Sistema de compilación o dependencias'},
        ci: {label: 'ci — integración continua', hint: 'Configuración de pipelines'},
        chore: {label: 'chore — mantenimiento', hint: 'Tareas que no tocan código de producción'},
        revert: {label: 'revert — revierte', hint: 'Deshace un commit anterior'},
    },
}
