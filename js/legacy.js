// Keep exactly the same dropdown population strategy as your other widgets.
(function () {
  function populateFirstColumnDropdown(values) {
    const dropdown = document.getElementById('firstColumnDropdown');
    if (!dropdown) return;

    // Conserve la sélection actuelle
    const currentSelection = dropdown.value;

    // Trier les valeurs par ordre alphabétique
    values.sort((a, b) => a.localeCompare(b));

    dropdown.innerHTML = '<option value="">Selectionner un projet</option>';

    values.forEach(value => {
      if (value) {
        const option = document.createElement('option');
        option.value = value;
        option.text = value;
        dropdown.appendChild(option);
      }
    });

    // Restaure la sélection précédente si elle est encore présente dans les options
    dropdown.value = currentSelection || '';
  }

  window.populateFirstColumnDropdown = populateFirstColumnDropdown;
})();
