/**
 * Product descriptions as suppliers deliver them (Unifiber, Patrik) and the
 * answers a model gives for them, shaped after the `translation_failed`
 * rows open in production on 2026-11-16 (docs/translations.md
 * § Validation). Hand-written samples, not copies of store content.
 */

/**
 * Unifiber's export: unclosed `<p>` and `<li>`, `<b>`, `<br>`, inline
 * styles, an empty styled span, `&nbsp;` spacers, a Word comment, a link
 * with `&amp;` in its query and an unquoted image source.
 */
export const UNIFIBER_RPM_SOURCE = `<!--[if gte mso 9]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]-->
<p style="margin:0;font-family:Arial"><b>RPM iWindsurf 280 (SL)</b><br>
The RPM boom for slalom sails, light and stiff.
<p><span style="color:#333"></span></p>
<p>&nbsp;</p>
<ul>
<li>Carbon tube 100%
<li>Adjustable 230-280 cm
<li>Weight 2.6 kg
</ul>
<P>More at <A HREF="https://www.unifiber.net/rpm?size=280&amp;ref=shop">unifiber.net</A></P>
<img src=https://cdn.example.com/rpm-280.jpg alt="RPM boom">`;

/** The model's Slovenian answer: the same document, tidied the way models tidy. */
export const UNIFIBER_RPM_ANSWER = `<p style="font-family:Arial;margin:0"><strong>RPM iWindsurf 280 (SL)</strong><br />
Bum RPM za slalomska jadra, lahek in tog.</p>
<ul>
<li>Karbonska cev 100%</li>
<li>Nastavljiv 230-280 cm</li>
<li>Teža 2,6 kg</li>
</ul>
<p>Več na <a href="https://www.unifiber.net/rpm?size=280&ref=shop">unifiber.net</a></p>
<img src="https://cdn.example.com/rpm-280.jpg" alt="Bum RPM" />`;

/** A spec table with unclosed cells and rows, and its answer with them closed. */
export const UNIFIBER_SDM_TABLE_SOURCE = `<table border=1 cellpadding=2><tbody>
<tr><td><b>Model</b><td>HD SDM C75
<tr><td><b>Length</b><td>460 cm
<tr><td><b>Weight</b><td>1.9 kg
</tbody></table>`;

export const UNIFIBER_SDM_TABLE_ANSWER = `<table cellpadding="2" border="1"><tbody>
<tr><td><strong>Model</strong></td><td>HD SDM C75</td></tr>
<tr><td><strong>Dolžina</strong></td><td>460 cm</td></tr>
<tr><td><strong>Teža</strong></td><td>1,9 kg</td></tr>
</tbody></table>`;

/**
 * A description the merchant wrote in Slovenian into the store's default
 * (English) field: there is nothing to translate into Slovenian.
 */
export const UNIFIBER_SDM_SLOVENIAN_SOURCE = `<p>Jambor <b>HD SDM C75</b> je trd in odziven, primeren za večja jadra.<br>
<p>Dolžina 460 cm, IMCS 25.</p>`;

/** The model returns it as it was, with the markup tidied. */
export const UNIFIBER_SDM_SLOVENIAN_ANSWER = `<p>Jambor <strong>HD SDM C75</strong> je trd in odziven, primeren za večja jadra.<br/></p>
<p>Dolžina 460 cm, IMCS 25.</p>`;

/** Patrik's short description, already Slovenian. */
export const PATRIK_BACK_WING_SOURCE =
  "<p>Zadnje krilo za Patrik foil, iz karbona, za mirnejšo in stabilnejšo vožnjo.</p>";

/** A specification string with nothing a translation could change. */
export const RPM_SPEC_ONLY = "<p>RPM iWindsurf 280 cm, 2.6 kg, SL</p>";
