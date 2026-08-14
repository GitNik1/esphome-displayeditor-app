#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "lvgl.h"

#define BRIDGE_BUFFER_LINES 24
#define BRIDGE_MAX_OBJECTS 4096
#define BRIDGE_MAX_IMAGES 512

enum bridge_type {
  BRIDGE_OBJ, BRIDGE_LABEL, BRIDGE_BUTTON, BRIDGE_SWITCH, BRIDGE_SLIDER,
  BRIDGE_CHECKBOX, BRIDGE_ARC, BRIDGE_BAR, BRIDGE_DROPDOWN, BRIDGE_ROLLER,
  BRIDGE_TEXTAREA, BRIDGE_KEYBOARD, BRIDGE_TILEVIEW, BRIDGE_TABVIEW,
  BRIDGE_LED, BRIDGE_SPINNER, BRIDGE_QRCODE, BRIDGE_SPINBOX, BRIDGE_IMAGE,
  BRIDGE_ANIMIMG, BRIDGE_METER
};

typedef struct {
  lv_obj_t *object;
  int type;
} bridge_object_t;

static lv_display_t *bridge_display;
static lv_indev_t *bridge_pointer;
static uint16_t *bridge_buffer;
static bridge_object_t bridge_objects[BRIDGE_MAX_OBJECTS];
static lv_image_dsc_t *bridge_images[BRIDGE_MAX_IMAGES];
static int bridge_object_count;
static int bridge_image_count;
static int pointer_x;
static int pointer_y;
static int pointer_pressed;

EM_JS(void, browser_flush, (const uint16_t *pixels, int x1, int y1, int x2, int y2), {
  if (Module.lvglFlush) Module.lvglFlush(pixels, x1, y1, x2, y2);
});

EM_JS(void, browser_event, (int handle, int kind, int value, const char *text), {
  if (Module.lvglEvent) Module.lvglEvent(handle, kind, value, text ? UTF8ToString(text) : "");
});

static uint32_t bridge_tick(void) { return (uint32_t)emscripten_get_now(); }

static void flush_callback(lv_display_t *display, const lv_area_t *area, uint8_t *pixels) {
  browser_flush((const uint16_t *)pixels, area->x1, area->y1, area->x2, area->y2);
  lv_display_flush_ready(display);
}

static void pointer_callback(lv_indev_t *indev, lv_indev_data_t *data) {
  (void)indev;
  data->point.x = pointer_x;
  data->point.y = pointer_y;
  data->state = pointer_pressed ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

static lv_obj_t *object_at(int handle) {
  return handle >= 0 && handle < bridge_object_count ? bridge_objects[handle].object : NULL;
}

static int object_type(int handle) {
  return handle >= 0 && handle < bridge_object_count ? bridge_objects[handle].type : -1;
}

static int object_handle(lv_obj_t *object, int type) {
  if (!object || bridge_object_count >= BRIDGE_MAX_OBJECTS) return -1;
  int handle = bridge_object_count++;
  bridge_objects[handle].object = object;
  bridge_objects[handle].type = type;
  return handle;
}

static void place(lv_obj_t *object, int x, int y, int width, int height) {
  lv_obj_set_pos(object, x, y);
  lv_obj_set_size(object, width > 0 ? width : LV_SIZE_CONTENT, height > 0 ? height : LV_SIZE_CONTENT);
}

static void event_callback(lv_event_t *event) {
  int handle = (int)(intptr_t)lv_event_get_user_data(event);
  lv_obj_t *object = lv_event_get_target(event);
  int type = object_type(handle);
  lv_event_code_t code = lv_event_get_code(event);
  int kind = code == LV_EVENT_CLICKED ? 1 : code == LV_EVENT_PRESSED ? 3 : code == LV_EVENT_RELEASED ? 4 : 2;
  int value = 0;
  const char *text = NULL;
  if (type == BRIDGE_SWITCH || type == BRIDGE_CHECKBOX || type == BRIDGE_BUTTON) {
    value = lv_obj_has_state(object, LV_STATE_CHECKED) ? 1 : 0;
  } else if (type == BRIDGE_SLIDER) value = lv_slider_get_value(object);
  else if (type == BRIDGE_ARC) value = lv_arc_get_value(object);
  else if (type == BRIDGE_DROPDOWN) value = lv_dropdown_get_selected(object);
  else if (type == BRIDGE_ROLLER) value = lv_roller_get_selected(object);
  else if (type == BRIDGE_SPINBOX) value = lv_spinbox_get_value(object);
  else if (type == BRIDGE_TEXTAREA) text = lv_textarea_get_text(object);
  browser_event(handle, kind, value, text);
}

static void clear_images(void) {
  for (int i = 0; i < bridge_image_count; i++) {
    if (!bridge_images[i]) continue;
    free((void *)bridge_images[i]->data);
    free(bridge_images[i]);
  }
  memset(bridge_images, 0, sizeof(bridge_images));
  bridge_image_count = 0;
}

EMSCRIPTEN_KEEPALIVE int lvgl_bridge_init(int width, int height) {
  if (width < 1 || height < 1 || width > 4096 || height > 4096) return 0;
  lv_init();
  lv_tick_set_cb(bridge_tick);
  bridge_display = lv_display_create(width, height);
  if (!bridge_display) return 0;
  size_t buffer_size = (size_t)width * BRIDGE_BUFFER_LINES * sizeof(uint16_t);
  bridge_buffer = malloc(buffer_size);
  if (!bridge_buffer) return 0;
  lv_display_set_color_format(bridge_display, LV_COLOR_FORMAT_RGB565);
  lv_display_set_buffers(bridge_display, bridge_buffer, NULL, buffer_size, LV_DISPLAY_RENDER_MODE_PARTIAL);
  lv_display_set_flush_cb(bridge_display, flush_callback);
  bridge_pointer = lv_indev_create();
  lv_indev_set_type(bridge_pointer, LV_INDEV_TYPE_POINTER);
  lv_indev_set_display(bridge_pointer, bridge_display);
  lv_indev_set_read_cb(bridge_pointer, pointer_callback);
  return 1;
}

EMSCRIPTEN_KEEPALIVE void lvgl_bridge_reset(uint32_t background) {
  lv_obj_clean(lv_screen_active());
  clear_images();
  memset(bridge_objects, 0, sizeof(bridge_objects));
  bridge_object_count = 0;
  lv_obj_set_style_bg_color(lv_screen_active(), lv_color_hex(background & 0xffffff), 0);
  lv_obj_set_style_bg_opa(lv_screen_active(), LV_OPA_COVER, 0);
}

EMSCRIPTEN_KEEPALIVE int lvgl_bridge_create(int type, int parent_handle, int x, int y, int width, int height) {
  lv_obj_t *parent = parent_handle >= 0 ? object_at(parent_handle) : lv_screen_active();
  if (!parent) parent = lv_screen_active();
  lv_obj_t *object = NULL;
  switch (type) {
    case BRIDGE_LABEL: object = lv_label_create(parent); break;
    case BRIDGE_BUTTON: object = lv_button_create(parent); break;
    case BRIDGE_SWITCH: object = lv_switch_create(parent); break;
    case BRIDGE_SLIDER: object = lv_slider_create(parent); break;
    case BRIDGE_CHECKBOX: object = lv_checkbox_create(parent); break;
    case BRIDGE_ARC: object = lv_arc_create(parent); break;
    case BRIDGE_BAR: object = lv_bar_create(parent); break;
    case BRIDGE_DROPDOWN: object = lv_dropdown_create(parent); break;
    case BRIDGE_ROLLER: object = lv_roller_create(parent); break;
    case BRIDGE_TEXTAREA: object = lv_textarea_create(parent); break;
    case BRIDGE_KEYBOARD: object = lv_keyboard_create(parent); break;
    case BRIDGE_TILEVIEW: object = lv_tileview_create(parent); break;
    case BRIDGE_TABVIEW: object = lv_tabview_create(parent); break;
    case BRIDGE_LED: object = lv_led_create(parent); break;
    case BRIDGE_SPINNER: object = lv_spinner_create(parent); break;
    case BRIDGE_QRCODE: object = lv_qrcode_create(parent); break;
    case BRIDGE_SPINBOX: object = lv_spinbox_create(parent); break;
    case BRIDGE_IMAGE: case BRIDGE_ANIMIMG: case BRIDGE_METER: object = lv_image_create(parent); break;
    default: object = lv_obj_create(parent); break;
  }
  if (!object) return -1;
  place(object, x, y, width, height);
  int handle = object_handle(object, type);
  if (handle < 0) { lv_obj_delete(object); return -1; }
  if (type == BRIDGE_BUTTON || type == BRIDGE_SWITCH || type == BRIDGE_SLIDER ||
      type == BRIDGE_CHECKBOX || type == BRIDGE_ARC || type == BRIDGE_DROPDOWN ||
      type == BRIDGE_ROLLER || type == BRIDGE_TEXTAREA || type == BRIDGE_SPINBOX) {
    lv_obj_add_event_cb(object, event_callback, LV_EVENT_VALUE_CHANGED, (void *)(intptr_t)handle);
    lv_obj_add_event_cb(object, event_callback, LV_EVENT_CLICKED, (void *)(intptr_t)handle);
    lv_obj_add_event_cb(object, event_callback, LV_EVENT_PRESSED, (void *)(intptr_t)handle);
    lv_obj_add_event_cb(object, event_callback, LV_EVENT_RELEASED, (void *)(intptr_t)handle);
  }
  return handle;
}

EMSCRIPTEN_KEEPALIVE int lvgl_bridge_add_label(int parent_handle, const char *text) {
  lv_obj_t *parent = object_at(parent_handle);
  if (!parent) return -1;
  lv_obj_t *label = lv_label_create(parent);
  lv_label_set_text(label, text ? text : "");
  lv_obj_center(label);
  return object_handle(label, BRIDGE_LABEL);
}

EMSCRIPTEN_KEEPALIVE int lvgl_bridge_add_page(int parent_handle, const char *title,
                                              int column, int row, int direction) {
  lv_obj_t *parent = object_at(parent_handle);
  if (!parent) return -1;
  lv_obj_t *page = NULL;
  if (object_type(parent_handle) == BRIDGE_TABVIEW) {
    page = lv_tabview_add_tab(parent, title ? title : "");
  } else if (object_type(parent_handle) == BRIDGE_TILEVIEW) {
    page = lv_tileview_add_tile(parent, column, row, (lv_dir_t)direction);
  }
  return page ? object_handle(page, BRIDGE_OBJ) : -1;
}

EMSCRIPTEN_KEEPALIVE void lvgl_bridge_set_text(int handle, const char *text, const char *secondary) {
  lv_obj_t *object = object_at(handle);
  if (!object) return;
  switch (object_type(handle)) {
    case BRIDGE_LABEL: lv_label_set_text(object, text ? text : ""); break;
    case BRIDGE_CHECKBOX: lv_checkbox_set_text(object, text ? text : ""); break;
    case BRIDGE_DROPDOWN: lv_dropdown_set_options(object, text ? text : ""); if (secondary) lv_dropdown_set_symbol(object, secondary); break;
    case BRIDGE_ROLLER: lv_roller_set_options(object, text ? text : "", secondary && strcmp(secondary, "INFINITE") == 0 ? LV_ROLLER_MODE_INFINITE : LV_ROLLER_MODE_NORMAL); break;
    case BRIDGE_TEXTAREA: lv_textarea_set_text(object, text ? text : ""); lv_textarea_set_placeholder_text(object, secondary ? secondary : ""); break;
    case BRIDGE_QRCODE: lv_qrcode_update(object, text ? text : "", text ? strlen(text) : 0); break;
    default: break;
  }
}

EMSCRIPTEN_KEEPALIVE void lvgl_bridge_configure(int handle, int minimum, int maximum, int value,
                                                int auxiliary, int flags) {
  lv_obj_t *object = object_at(handle);
  if (!object) return;
  if (maximum <= minimum) maximum = minimum + 1;
  switch (object_type(handle)) {
    case BRIDGE_LABEL:
      lv_label_set_long_mode(object, (lv_label_long_mode_t)flags);
      /* LVGL 9 removed the label recolor parser; text remains safely literal. */
      (void)auxiliary; break;
    case BRIDGE_BUTTON:
      if (flags) lv_obj_add_flag(object, LV_OBJ_FLAG_CHECKABLE); else lv_obj_remove_flag(object, LV_OBJ_FLAG_CHECKABLE);
      if (value) lv_obj_add_state(object, LV_STATE_CHECKED); else lv_obj_remove_state(object, LV_STATE_CHECKED); break;
    case BRIDGE_SWITCH: case BRIDGE_CHECKBOX:
      if (value) lv_obj_add_state(object, LV_STATE_CHECKED); else lv_obj_remove_state(object, LV_STATE_CHECKED); break;
    case BRIDGE_SLIDER: lv_slider_set_range(object, minimum, maximum); lv_slider_set_mode(object, (lv_slider_mode_t)flags); lv_slider_set_value(object, value, LV_ANIM_OFF); break;
    case BRIDGE_ARC:
      lv_arc_set_range(object, minimum, maximum); lv_arc_set_value(object, value);
      lv_arc_set_bg_angles(object, auxiliary & 0xffff, (auxiliary >> 16) & 0xffff);
      lv_arc_set_rotation(object, flags & 0xffff); lv_arc_set_mode(object, (lv_arc_mode_t)((flags >> 16) & 0xff)); break;
    case BRIDGE_BAR:
      lv_bar_set_range(object, minimum, maximum); lv_bar_set_value(object, value, LV_ANIM_OFF);
      lv_bar_set_mode(object, (lv_bar_mode_t)((flags >> 8) & 0xff));
      if (flags) lv_bar_set_start_value(object, auxiliary, LV_ANIM_OFF); break;
    case BRIDGE_DROPDOWN: lv_dropdown_set_selected(object, value); break;
    case BRIDGE_ROLLER: lv_roller_set_selected(object, value, LV_ANIM_OFF); if (auxiliary > 0) lv_roller_set_visible_row_count(object, auxiliary); break;
    case BRIDGE_TEXTAREA:
      lv_textarea_set_one_line(object, flags & 1); lv_textarea_set_password_mode(object, flags & 2);
      if (maximum > 0) lv_textarea_set_max_length(object, maximum); break;
    case BRIDGE_LED: lv_led_set_brightness(object, value < 0 ? 0 : value > 255 ? 255 : value); lv_led_set_color(object, lv_color_hex((uint32_t)auxiliary)); break;
    case BRIDGE_SPINNER: lv_spinner_set_anim_params(object, value > 0 ? value : 1000, auxiliary > 0 ? auxiliary : 200); break;
    case BRIDGE_QRCODE: lv_qrcode_set_size(object, value > 0 ? value : 100); lv_qrcode_set_dark_color(object, lv_color_hex((uint32_t)auxiliary)); lv_qrcode_set_light_color(object, lv_color_hex((uint32_t)flags)); break;
    case BRIDGE_SPINBOX:
      lv_spinbox_set_range(object, minimum, maximum); lv_spinbox_set_value(object, value);
      lv_spinbox_set_digit_format(object, auxiliary > 0 ? auxiliary : 4, flags >= 0 ? flags : 0); break;
    case BRIDGE_IMAGE: case BRIDGE_ANIMIMG:
      lv_image_set_rotation(object, auxiliary);
      lv_image_set_scale(object, flags > 0 ? flags : 256); break;
    default: break;
  }
}

EMSCRIPTEN_KEEPALIVE void lvgl_bridge_link(int handle, int target_handle, int mode, int auxiliary) {
  lv_obj_t *object = object_at(handle);
  lv_obj_t *target = object_at(target_handle);
  if (!object) return;
  if (object_type(handle) == BRIDGE_KEYBOARD) {
    if (target) lv_keyboard_set_textarea(object, target);
    lv_keyboard_set_mode(object, (lv_keyboard_mode_t)mode);
  } else if (object_type(handle) == BRIDGE_TABVIEW) {
    lv_tabview_set_tab_bar_position(object, (lv_dir_t)mode);
    lv_tabview_set_tab_bar_size(object, auxiliary);
  }
}

EMSCRIPTEN_KEEPALIVE void lvgl_bridge_select_page(int handle, int index, int column, int row) {
  lv_obj_t *object = object_at(handle);
  if (!object) return;
  if (object_type(handle) == BRIDGE_TABVIEW) lv_tabview_set_active(object, index, LV_ANIM_OFF);
  else if (object_type(handle) == BRIDGE_TILEVIEW) lv_tileview_set_tile_by_index(object, column, row, LV_ANIM_OFF);
}

EMSCRIPTEN_KEEPALIVE void lvgl_bridge_set_state(int handle, int disabled, int checked) {
  lv_obj_t *object = object_at(handle);
  if (!object) return;
  if (disabled) lv_obj_add_state(object, LV_STATE_DISABLED); else lv_obj_remove_state(object, LV_STATE_DISABLED);
  if (checked) lv_obj_add_state(object, LV_STATE_CHECKED); else lv_obj_remove_state(object, LV_STATE_CHECKED);
}

EMSCRIPTEN_KEEPALIVE void lvgl_bridge_set_style(int handle, int part, int state, uint32_t background, uint32_t foreground,
                                                uint32_t border, int border_width, int radius, int opacity,
                                                uint32_t line_color, int line_width) {
  lv_obj_t *object = object_at(handle);
  if (!object) return;
  lv_part_t selector = LV_PART_MAIN;
  if (part == 1) selector = LV_PART_INDICATOR;
  else if (part == 2) selector = LV_PART_KNOB;
  else if (part == 3) selector = LV_PART_SELECTED;
  else if (part == 4) selector = LV_PART_ITEMS;
  else if (part == 5) selector = LV_PART_CURSOR;
  if (state == 1) selector |= LV_STATE_CHECKED;
  else if (state == 2) selector |= LV_STATE_PRESSED;
  else if (state == 3) selector |= LV_STATE_FOCUSED;
  else if (state == 4) selector |= LV_STATE_DISABLED;
  lv_obj_set_style_bg_color(object, lv_color_hex(background & 0xffffff), selector);
  lv_obj_set_style_bg_opa(object, opacity < 0 ? LV_OPA_COVER : (lv_opa_t)opacity, selector);
  lv_obj_set_style_text_color(object, lv_color_hex(foreground & 0xffffff), selector);
  lv_obj_set_style_border_color(object, lv_color_hex(border & 0xffffff), selector);
  lv_obj_set_style_border_width(object, border_width < 0 ? 0 : border_width, selector);
  lv_obj_set_style_radius(object, radius < 0 ? 0 : radius, selector);
  lv_obj_set_style_arc_color(object, lv_color_hex(line_color & 0xffffff), selector);
  lv_obj_set_style_arc_width(object, line_width < 0 ? 0 : line_width, selector);
  lv_obj_set_style_line_color(object, lv_color_hex(line_color & 0xffffff), selector);
  lv_obj_set_style_line_width(object, line_width < 0 ? 0 : line_width, selector);
}

EMSCRIPTEN_KEEPALIVE int lvgl_bridge_set_image_rgba(int handle, int width, int height, const uint8_t *rgba) {
  lv_obj_t *object = object_at(handle);
  if (!object || !rgba || width < 1 || height < 1 || width > 2048 || height > 2048 || bridge_image_count >= BRIDGE_MAX_IMAGES) return 0;
  lv_image_dsc_t *image = calloc(1, sizeof(lv_image_dsc_t));
  uint8_t *pixels = malloc((size_t)width * height * 4);
  if (!image || !pixels) { free(image); free(pixels); return 0; }
  for (int i = 0; i < width * height; i++) {
    pixels[i * 4] = rgba[i * 4 + 2];
    pixels[i * 4 + 1] = rgba[i * 4 + 1];
    pixels[i * 4 + 2] = rgba[i * 4];
    pixels[i * 4 + 3] = rgba[i * 4 + 3];
  }
  image->header.magic = LV_IMAGE_HEADER_MAGIC;
  image->header.cf = LV_COLOR_FORMAT_ARGB8888;
  image->header.w = width;
  image->header.h = height;
  image->header.stride = width * 4;
  image->data_size = (uint32_t)width * height * 4;
  image->data = pixels;
  bridge_images[bridge_image_count++] = image;
  lv_image_set_src(object, image);
  return 1;
}

EMSCRIPTEN_KEEPALIVE void lvgl_bridge_pointer(int x, int y, int pressed) {
  pointer_x = x; pointer_y = y; pointer_pressed = pressed != 0;
  if (bridge_pointer) lv_indev_read(bridge_pointer);
}

EMSCRIPTEN_KEEPALIVE int lvgl_bridge_frame(void) { return (int)lv_timer_handler(); }
EMSCRIPTEN_KEEPALIVE int lvgl_bridge_object_count(void) { return bridge_object_count; }
