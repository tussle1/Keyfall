/**
 * Motion curves for the trainer panel. These are spring-inspired Bézier
 * approximations, not a physics loop: direct manipulation stays attached to
 * the pointer, while released controls settle quickly with a little overshoot.
 * Kept here so CSS and the animated tab resize use the same timing language.
 */
export const MOTION = {
  curve: {
    smooth: "cubic-bezier(.22, 1, .36, 1)",
    spring: "cubic-bezier(.2, .8, .2, 1.16)",
    exit: "cubic-bezier(.4, 0, 1, 1)",
    press: "cubic-bezier(.3, 0, .7, 1)",
  },
  ms: {
    panelEnter: 460,
    panelExit: 200,
    drawerEnter: 420,
    drawerExit: 220,
    tabResize: 360,
    tabEnter: 300,
    controlSpring: 420,
    sliderSettle: 300,
    press: 95,
  },
} as const;
