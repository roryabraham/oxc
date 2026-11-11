use oxc_span::SourceType;
use oxc_transformer::TransformOptions;

use crate::{codegen, test};

/// Renaming a constructor binding that clashes with a field initializer must also rename
/// the catch parameter linked to it by a same-named `var`, so both declarations still match.
#[test]
fn rename_catch_parameter_linked_to_clashing_var() {
    let options = TransformOptions::from_target("es2021").unwrap();
    let source =
        "let x; class C { y = x; constructor() { try {} catch (x) { var x = 1 } use(x) } }";
    let expected = "import _defineProperty from '@oxc-project/runtime/helpers/defineProperty';
        let x; class C { constructor() { _defineProperty(this, 'y', x); try {} catch (_x) { var _x = 1 } use(_x) } }";
    assert_eq!(test(source, &options), Ok(codegen(expected, SourceType::default())));
}
